// Blockscout v2 client for Base. Read-only, no key, no account.
// Note: base.blockscout.com sits behind Cloudflare and rejects requests without a Referer.
// Browsers send one automatically, which is why this works from a static page and did not
// work from curl until a Referer was added.

const BASE = 'https://base.blockscout.com/api/v2';

// Two layers: an in-memory map for the current page, and sessionStorage so a reload or a
// second scan of the same address does not pay the indexer's latency again. The public
// Blockscout instance takes anywhere from 2 s to 11 s per call under load, so caching is
// the difference between "instant" and "come back later" on a repeat visit.
const cache = new Map();
const SS_PREFIX = 'bwg.bs.v1:';
const SS_TTL = 5 * 60 * 1000;

function ssGet(path) {
  try {
    const raw = sessionStorage.getItem(SS_PREFIX + path);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw);
    if (Date.now() - at > SS_TTL) {
      sessionStorage.removeItem(SS_PREFIX + path);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function ssSet(path, data) {
  try {
    sessionStorage.setItem(SS_PREFIX + path, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // quota or private mode: the in-memory cache still works
  }
}

async function get(path, { timeout = 25000, retries = 2 } = {}) {
  if (cache.has(path)) return cache.get(path);

  const stored = ssGet(path);
  if (stored) {
    cache.set(path, stored);
    return stored;
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try {
      const res = await fetch(BASE + path, {
        headers: { Accept: 'application/json' },
        signal: c.signal,
        cache: 'default',
      });
      if (res.status === 429) throw new Error('rate limited');
      if (!res.ok) throw new Error(`Blockscout HTTP ${res.status}`);
      const json = await res.json();
      cache.set(path, json);
      ssSet(path, json);
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(350 * (attempt + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`Blockscout unavailable (${lastErr && lastErr.message}). ${BASE}${path}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function addressInfo(address) {
  return get(`/addresses/${address}`);
}

/**
 * Every token the address holds, per the indexer.
 * Deliberately does NOT swallow errors: a failed token list is not an empty token list,
 * and a security scan that cannot tell those apart would report a false all-clear.
 */
export async function tokenBalances(address) {
  return get(`/addresses/${address}/token-balances`);
}

export async function counters(address) {
  try {
    return await get(`/addresses/${address}/counters`);
  } catch {
    return null;
  }
}

function toQuery(params) {
  if (!params) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  return '?' + q.toString();
}

/**
 * Page through a Blockscout list endpoint.
 * @param {string} address
 * @param {'transactions'|'token-transfers'} kind
 * @param {number} maxItems hard cap
 */
export async function paged(address, kind, maxItems, onProgress) {
  const items = [];
  let params = null;
  let pages = 0;
  const maxPages = Math.ceil(maxItems / 50) + 2;

  while (items.length < maxItems && pages < maxPages) {
    const path = `/addresses/${address}/${kind}${toQuery(params)}`;
    const page = await get(path);
    const batch = page.items || [];
    if (!batch.length) break;
    for (const it of batch) {
      if (items.length >= maxItems) break;
      items.push(it);
    }
    pages++;
    if (onProgress) onProgress(items.length);
    params = page.next_page_params;
    if (!params) break;
    await sleep(120);
  }
  return items;
}

export async function transactions(address, maxItems = 50, onProgress) {
  return paged(address, 'transactions', maxItems, onProgress);
}

export async function tokenTransfers(address, maxItems = 100, onProgress) {
  return paged(address, 'token-transfers', maxItems, onProgress);
}

export async function tokenInfo(address) {
  try {
    return await get(`/tokens/${address}`);
  } catch {
    return null;
  }
}

export function isSpamToken(token) {
  if (!token) return true;
  const rep = (token.reputation || '').toLowerCase();
  if (rep === 'spam' || rep === 'scam') return true;
  if (token.is_scam) return true;
  return false;
}
