#!/usr/bin/env node
/**
 * Sneaker Price Alert Bot – Discord & Telegram alerts when a StockX price drops
 *
 * Watches the sneakers in watchlist.json and sends an alert when the lowest ask
 * for your size drops to (or below) your target price.
 *
 * Zero dependencies, Node.js 18+.
 *
 * API:     https://rapidapi.com/belchiorarkad-FqvHs2EDOtP/api/sneaker-database-stockx
 * Support: Telegram @pintoflow
 *
 * Env:
 *   RAPIDAPI_KEY          your RapidAPI key (required)
 *   DISCORD_WEBHOOK_URL   Discord channel webhook (optional)
 *   TELEGRAM_BOT_TOKEN    Telegram bot token (optional)
 *   TELEGRAM_CHAT_ID      Telegram chat/channel id (optional)
 *   CHECK_EVERY_MINUTES   default 30 (minimum 15: prices are cached 5 min server-side)
 *
 *   node src/bot.js           run forever
 *   node src/bot.js --once    one check, then exit (for cron / GitHub Actions)
 */
const fs = require('fs');
const path = require('path');
const { loadEnv, api, ApiError, findSizes, pickNum, sameSize } = require('./lib');

loadEnv(path.join(__dirname, '..', '.env'));

const ROOT = path.join(__dirname, '..');
const WATCHLIST = path.join(ROOT, 'watchlist.json');
const STATE = path.join(ROOT, 'state.json');
const ONCE = process.argv.includes('--once');
const EVERY = Math.max(15, Number(process.env.CHECK_EVERY_MINUTES) || 30);

if (!process.env.RAPIDAPI_KEY) {
  console.error('Missing RAPIDAPI_KEY. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const state = readJson(STATE, { products: {}, notFound: {}, lastAlert: {} });
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

async function resolve(styleId) {
  if (state.products[styleId]) return state.products[styleId];
  const miss = state.notFound[styleId];
  if (miss && Date.now() - miss < 24 * 3600e3) return null; // don't retry a 404 for a day
  try {
    const p = await api('/stockx/product-by-style', { styleId });
    state.products[styleId] = { urlKey: p.urlKey, title: p.title, image: p.image, url: p.url, retailPrice: p.retailPrice };
    delete state.notFound[styleId];
    saveState();
    return state.products[styleId];
  } catch (e) {
    if (e.status === 404) { state.notFound[styleId] = Date.now(); saveState(); console.warn(`  ${styleId}: not on StockX, skipping for 24 h`); return null; }
    throw e;
  }
}

async function notify(item, product, ask, currency) {
  const text = `🔥 Price drop: ${product.title} (US ${item.size}) is ${currency} ${ask} on StockX – your target was ${currency} ${item.targetPrice}.`;
  console.log('  ALERT ' + text);

  if (process.env.DISCORD_WEBHOOK_URL) {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Sneaker Price Alert',
        embeds: [{
          title: `🔥 ${product.title}`,
          url: product.url,
          color: 0x22c55e,
          thumbnail: product.image ? { url: product.image } : undefined,
          fields: [
            { name: 'Size', value: `US ${item.size}`, inline: true },
            { name: 'Lowest ask', value: `${currency} ${ask}`, inline: true },
            { name: 'Your target', value: `${currency} ${item.targetPrice}`, inline: true },
            { name: 'Style code', value: item.styleId, inline: true },
            { name: 'Retail', value: product.retailPrice ? `$${product.retailPrice}` : '–', inline: true },
          ],
          footer: { text: 'Sneaker Database – StockX API · rapidapi.com' },
          timestamp: new Date().toISOString(),
        }],
      }),
    }).catch((e) => console.warn('  Discord failed: ' + e.message));
  }

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `${text}\n${product.url || ''}` }),
    }).catch((e) => console.warn('  Telegram failed: ' + e.message));
  }
}

async function check() {
  const list = readJson(WATCHLIST, []);
  console.log(`[${new Date().toLocaleString()}] Checking ${list.length} sneaker(s)…`);
  for (const item of list) {
    const currency = item.currency || 'USD';
    try {
      const product = await resolve(item.styleId);
      if (!product) continue;
      const market = await api('/stockx/market-data', { urlKey: product.urlKey, currency, country: item.country || 'US' });
      const row = findSizes(market).find((s) => sameSize(s, item.size));
      const ask = row && pickNum(row, 'lowestAsk', 'lowest_ask', 'ask');
      if (!ask) { console.log(`  ${item.styleId} US ${item.size}: no asks right now`); continue; }
      console.log(`  ${product.title} US ${item.size}: ${currency} ${ask} (target ${item.targetPrice})`);

      const key = `${item.styleId}|${item.size}|${currency}`;
      const prev = state.lastAlert[key];
      // Alert once per price level: only again if it drops further.
      if (ask <= item.targetPrice && (!prev || ask < prev)) {
        await notify(item, product, ask, currency);
        state.lastAlert[key] = ask;
        saveState();
      } else if (ask > item.targetPrice && prev) {
        delete state.lastAlert[key]; // price went back up: re-arm the alert
        saveState();
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status >= 500 || e.status === 429)) {
        console.warn(`  ${item.styleId}: ${e.status} ${e.code || ''}, will retry next round`);
      } else {
        console.warn(`  ${item.styleId}: ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1500)); // keep concurrency low
  }
}

(async () => {
  await check();
  if (ONCE) return;
  console.log(`Next check in ${EVERY} min. Ctrl+C to stop.`);
  setInterval(check, EVERY * 60e3);
})();
