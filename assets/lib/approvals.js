// Approval risk engine.
//
// What this can and cannot see, stated plainly because the UI has to repeat it:
//
//   A complete approval history needs an archive-node eth_getLogs sweep over the wallet's whole
//   lifetime. Every free public Base RPC caps that: publicnode 50k blocks, drpc 10k, tenderly 1k,
//   1rpc 50, blastapi 10. Base produces ~43,200 blocks/day, so a full sweep is 1,000+ requests per
//   token and no free endpoint allows it from a browser.
//
//   So instead of scanning history, this engine asks the chain a better question: "what is the
//   CURRENT allowance, right now?" It checks every token the wallet holds against every spender
//   that can actually move it (a verified registry of Base routers, aggregators, lending markets
//   and marketplaces, plus every contract this wallet has interacted with). allowance() is the
//   authoritative number — an approval that has been revoked reads 0 and is dropped.
//
//   The one thing that escapes: an approval granted to a contract this wallet never transacted
//   with directly. That is rare, and the UI says so rather than claiming completeness.

import { SPENDERS, CORE_TOKENS, CHAIN } from './registry.js';
import { batchCall, batchRpc, encAllowance, encBalanceOf, decodeUint, getBalance, rpc } from './rpc.js';
import * as bs from './blockscout.js';

export const UNLIMITED = 2n ** 255n;

/** Human-readable magnitude of an allowance relative to the token's own supply scale. */
function tier(allowance, decimals) {
  if (allowance === 0n) return 'none';
  if (allowance >= UNLIMITED) return 'unlimited';
  const scale = 10n ** BigInt(decimals);
  const whole = allowance / scale;
  if (whole >= 1_000_000_000n) return 'unlimited'; // 1e9 tokens behaves like unlimited in practice
  if (whole >= 1_000_000n) return 'high';
  return 'limited';
}

function num(v) {
  return v === null || v === undefined ? 0 : Number(v);
}

/**
 * Build the token set: core blue chips (always) + everything the wallet actually holds,
 * ranked by USD value, spam filtered out.
 */
export function buildTokenSet(balances) {
  const byAddr = new Map();
  for (const t of CORE_TOKENS) {
    byAddr.set(t.address.toLowerCase(), { ...t, balance: 0n, usd: 0, held: false });
  }
  for (const row of balances || []) {
    const tk = row.token || {};
    const addr = (tk.address_hash || tk.address || '').toLowerCase();
    if (!addr) continue;
    if (bs.isSpamToken(tk)) continue;
    const decimals = Number(tk.decimals ?? 18);
    let value = 0n;
    try {
      value = BigInt(row.value ?? '0');
    } catch {
      value = 0n;
    }
    if (value === 0n) continue;
    const rate = tk.exchange_rate ? Number(tk.exchange_rate) : 0;
    const usd = rate ? (Number(value) / 10 ** decimals) * rate : 0;
    const prev = byAddr.get(addr);
    if (prev) {
      prev.balance = value;
      prev.held = true;
      prev.usd = usd;
      prev.symbol = tk.symbol || prev.symbol;
      if (tk.exchange_rate) prev.rate = rate;
    } else {
      byAddr.set(addr, {
        address: tk.address_hash || tk.address,
        symbol: tk.symbol || 'TOKEN',
        decimals,
        balance: value,
        usd,
        held: true,
        rate,
        reputation: tk.reputation,
      });
    }
  }

  const all = [...byAddr.values()];
  const held = all.filter((t) => t.held).sort((a, b) => b.usd - a.usd);
  const core = all.filter((t) => t.core && !t.held);
  // 8 held tokens by value + core tokens not already held, capped so the matrix stays fast
  return [...held.slice(0, 8), ...core].slice(0, 14);
}

/** Contracts this wallet has talked to, which are plausible spenders for its tokens. */
export function discoverSpenders(txs, wallet) {
  const w = wallet.toLowerCase();
  const known = new Set(SPENDERS.map((s) => s.address.toLowerCase()));
  const counts = new Map();

  for (const tx of txs || []) {
    const to = tx.to && tx.to.hash ? tx.to.hash.toLowerCase() : null;
    if (!to || to === w) continue;
    if (!tx.to.is_contract) continue;
    if (known.has(to)) continue;
    counts.set(to, (counts.get(to) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([address, n]) => ({
      address,
      name: null,
      kind: 'Observed',
      note: `Contract this wallet interacted with ${n} time${n === 1 ? '' : 's'}.`,
    }));
}

/**
 * The blue-chip set with zero balances. The allowance matrix can run against this
 * before any balance is known, because allowance() does not depend on the balance.
 */
export function coreTokenSet() {
  return CORE_TOKENS.map((t) => ({ ...t, balance: 0n, usd: 0, held: false }));
}

/**
 * Read live balances for the blue-chip token set straight from the chain.
 * One JSON-RPC batch, ~250 ms — this is what makes the risk answer available before
 * any indexer responds.
 */
export async function readCoreBalances(wallet) {
  const calls = [
    { method: 'eth_getBalance', params: [wallet, 'latest'] },
    ...CORE_TOKENS.map((t) => ({
      method: 'eth_call',
      params: [{ to: t.address, data: encBalanceOf(wallet) }, 'latest'],
    })),
  ];
  const out = await batchRpc(calls, { parallel: 2 });

  const ethHex = out[0] || '0x0';
  const tokens = CORE_TOKENS.map((t, i) => ({
    ...t,
    balance: decodeUint(out[i + 1]) || 0n,
    usd: 0,
    held: (decodeUint(out[i + 1]) || 0n) > 0n,
  }));

  return { ethBalance: ethHex, tokens };
}

/**
 * Read allowance(owner, spender) across a token × spender matrix.
 * Pure chain reads, no indexer. Returns the raw rows; balances on the rows are whatever
 * the token objects carried in, and are re-applied by `withBalances` when fresher numbers arrive.
 */
export async function runMatrix(wallet, tokens, spenders) {
  const calls = [];
  const meta = [];
  for (const t of tokens) {
    for (const s of spenders) {
      calls.push({ to: t.address, data: encAllowance(wallet, s.address) });
      meta.push({ token: t, spender: s });
    }
  }
  if (!calls.length) return { rows: [], checks: 0 };

  const results = await batchCall(calls, { parallel: 8 });

  const rows = [];
  for (let i = 0; i < results.length; i++) {
    const raw = results[i];
    if (raw === null) continue;
    const allowance = decodeUint(raw);
    if (allowance === null || allowance === 0n) continue;

    const { token, spender } = meta[i];
    rows.push({
      token: token.symbol,
      tokenAddress: token.address,
      tokenDecimals: token.decimals,
      balance: token.balance || 0n,
      allowance,
      tier: tier(allowance, token.decimals),
      spender: spender.name || 'Unnamed contract',
      spenderAddress: spender.address,
      spenderKind: spender.kind,
      note: spender.note || '',
      rate: token.rate || 0,
      usdAtRisk: 0,
    });
  }
  return { rows, checks: calls.length };
}

/** Recompute exposure on existing rows once real balances and prices are known. */
export function withBalances(rows, tokenIndex) {
  for (const r of rows) {
    const t = tokenIndex.get(r.tokenAddress.toLowerCase());
    if (t) {
      r.balance = t.balance;
      if (t.rate) r.rate = t.rate;
      r.tier = tier(r.allowance, r.tokenDecimals);
    }
    const exposed = r.allowance < r.balance ? r.allowance : r.balance;
    r.usdAtRisk = r.rate ? (Number(exposed) / 10 ** r.tokenDecimals) * r.rate : 0;
  }
  return sortRows(rows);
}

export function sortRows(rows) {
  const order = { unlimited: 0, high: 1, limited: 2 };
  return rows.sort((a, b) => {
    if (order[a.tier] !== order[b.tier]) return order[a.tier] - order[b.tier];
    if (b.usdAtRisk !== a.usdAtRisk) return b.usdAtRisk - a.usdAtRisk;
    return a.token.localeCompare(b.token);
  });
}

/**
 * One-shot scan used by the API surface and by tests. The UI orchestrates the same
 * primitives itself so it can paint the risk answer before the indexer replies.
 */
export async function scanApprovals({ wallet, balances, txs, onProgress }) {
  const tokens = buildTokenSet(balances);
  const spenders = [...SPENDERS.map((s) => ({ ...s })), ...discoverSpenders(txs, wallet)];

  if (onProgress) onProgress(`Reading allowances from Base`);
  const { rows, checks } = await runMatrix(wallet, tokens, spenders);

  const ethHex = await getBalance(wallet);
  const info = await bs.addressInfo(wallet).catch(() => null);
  const ethPrice = num(info && info.exchange_rate);

  return {
    rows: sortRows(withBalances(rows, new Map(tokens.map((t) => [t.address.toLowerCase(), t])))),
    ethBalance: ethHex,
    ethPrice,
    matrix: { tokens: tokens.length, spenders: spenders.length, checks },
    tokens,
  };
}

/** Current token balances refreshed right before a revoke, so the user sees live numbers. */
export async function refreshBalances(wallet, tokens) {
  if (!tokens.length) return [];
  const out = await batchCall(tokens.map((t) => ({ to: t.address, data: encBalanceOf(wallet) })), { parallel: 4 });
  return out.map((r, i) => ({ token: tokens[i], balance: decodeUint(r) || 0n }));
}

export async function ethBalanceOf(address) {
  return getBalance(address);
}

export async function nativePrice() {
  try {
    const info = await bs.addressInfo(CHAIN.usdc);
    return num(info && info.exchange_rate);
  } catch {
    return 0;
  }
}

export { rpc };
