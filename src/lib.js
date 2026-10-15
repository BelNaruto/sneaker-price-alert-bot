const fs = require('fs');

const HOST = 'sneaker-database-stockx.p.rapidapi.com';

/** Minimal .env loader so the bot needs no dependencies. */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
  }
}

async function api(route, params) {
  const url = new URL(`https://${HOST}${route}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': process.env.RAPIDAPI_KEY } });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) throw new ApiError(res.status, body);
  return body?.data ?? body;
}

/** Return the per-size array from a /stockx/market-data response. */
function findSizes(data) {
  if (Array.isArray(data)) return data;
  for (const k of ['sizes', 'variants', 'market', 'data']) if (Array.isArray(data?.[k])) return data[k];
  return [];
}

function pickNum(o, ...keys) {
  for (const k of keys) {
    let v = o?.[k];
    if (v && typeof v === 'object') v = v.amount ?? v.price ?? v.value;
    const n = Number(v);
    if (n > 0) return n;
  }
  return null;
}

/** True when a size row matches "10", "US 10", "10M", etc. */
function sameSize(row, wanted) {
  const norm = (s) => String(s ?? '').toUpperCase().replace(/^US\s*/, '').replace(/[MW]$/, '').trim();
  const w = norm(wanted);
  const cands = [row.size, row.sizeUS, row.us, row.name, row.sizes?.us, row.conversions?.US];
  return cands.some((c) => c != null && norm(c) === w);
}

module.exports = { loadEnv, api, ApiError, findSizes, pickNum, sameSize };
