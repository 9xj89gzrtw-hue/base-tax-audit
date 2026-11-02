// Ledger construction, classification and FIFO cost-basis matching.
//
// Price sources, stated exactly because the export says so per row:
//   - USD / USDT / DAI  -> 1.00 by definition of the instrument
//   - ETH and WETH      -> the historic ETH/USD rate Blockscout recorded on that transaction
//   - any other ERC-20  -> the token's current Blockscout rate, flagged `spot`
// Only the last case carries error. Every exported row states which source priced it, so a
// preparer can substitute their exchange's historical prices without guessing which rows matter.

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'EURC', 'USDbC', 'crvUSD', 'GHO', 'LUSD']);
const ETH_LIKE = new Set(['ETH', 'WETH']);

const DEX_HINTS = [
  'swap', 'execute', 'exactInput', 'exactOutput', 'multicall', 'fillOrder', 'settle',
  'addLiquidity', 'removeLiquidity', 'mint', 'burn', 'supply', 'withdraw', 'repay',
  'borrow', 'deposit', 'redeem', 'stake', 'unstake', 'claim',
];

export function classifyMethod(method) {
  if (!method) return 'call';
  const m = method.toLowerCase();
  for (const h of DEX_HINTS) if (m.includes(h.toLowerCase())) return 'defi';
  return 'call';
}

function isoToKoinly(ts) {
  // Blockscout: 2026-11-01T16:31:59.000000Z
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function yearOf(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear();
}

function fmtAmount(value, decimals, maxFrac = 8) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  let fs = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  if (fs.length > maxFrac) fs = fs.slice(0, maxFrac);
  return fs ? `${whole}.${fs}` : `${whole}`;
}

function priceOf(symbol, tx, tokenRate) {
  const s = (symbol || '').toUpperCase();
  if (STABLES.has(s)) return { price: 1, source: 'stable' };
  if (ETH_LIKE.has(s)) {
    const h = Number(tx && tx.historic_exchange_rate);
    if (h > 0) return { price: h, source: 'historic' };
    const c = Number(tx && tx.exchange_rate);
    if (c > 0) return { price: c, source: 'spot' };
    return { price: 0, source: 'unknown' };
  }
  if (tokenRate > 0) return { price: tokenRate, source: 'spot' };
  return { price: 0, source: 'unknown' };
}

/**
 * Merge transactions and token transfers into one row per transaction.
 */
export function buildLedger({ wallet, txs, transfers }) {
  const w = wallet.toLowerCase();
  const byTx = new Map();

  const ensure = (hash, seed) => {
    if (!byTx.has(hash)) {
      byTx.set(hash, {
        txHash: hash,
        timestamp: seed.timestamp,
        block: seed.block,
        method: seed.method || '',
        from: seed.from,
        to: seed.to,
        feeWei: 0n,
        feeUsd: 0,
        sent: [],
        received: [],
        priceSources: new Set(),
      });
    }
    return byTx.get(hash);
  };

  for (const tx of txs || []) {
    const from = tx.from && tx.from.hash ? tx.from.hash.toLowerCase() : '';
    const to = tx.to && tx.to.hash ? tx.to.hash.toLowerCase() : '';
    if (from !== w && to !== w) continue;

    const row = ensure(tx.hash, {
      timestamp: tx.timestamp,
      block: tx.block_number,
      method: tx.method,
      from,
      to,
    });

    if (from === w && tx.fee && tx.fee.value) {
      row.feeWei = BigInt(tx.fee.value);
      const p = priceOf('ETH', tx, 0);
      row.feeUsd = (Number(row.feeWei) / 1e18) * p.price;
      row.priceSources.add(p.source);
    }

    let value = 0n;
    try {
      value = BigInt(tx.value || '0');
    } catch {
      value = 0n;
    }
    if (value > 0n) {
      const p = priceOf('ETH', tx, 0);
      if (to === w) row.received.push({ symbol: 'ETH', decimals: 18, amount: value, usd: (Number(value) / 1e18) * p.price, counterparty: from, isContract: tx.from && tx.from.is_contract });
      if (from === w) row.sent.push({ symbol: 'ETH', decimals: 18, amount: value, usd: (Number(value) / 1e18) * p.price, counterparty: to, isContract: tx.to && tx.to.is_contract });
      row.priceSources.add(p.source);
    }
  }

  for (const tr of transfers || []) {
    const from = tr.from && tr.from.hash ? tr.from.hash.toLowerCase() : '';
    const to = tr.to && tr.to.hash ? tr.to.hash.toLowerCase() : '';
    if (from !== w && to !== w) continue;
    const tk = tr.token || {};
    if (tk.type && tk.type !== 'ERC-20') continue;
    if (tk.reputation === 'spam' || tk.reputation === 'scam') continue;

    const hash = tr.transaction_hash;
    const row = ensure(hash, {
      timestamp: tr.timestamp,
      block: tr.block_number,
      method: tr.method,
      from,
      to,
    });

    const decimals = Number((tr.total && tr.total.decimals) ?? tk.decimals ?? 18);
    let amount = 0n;
    try {
      amount = BigInt((tr.total && tr.total.value) ?? '0');
    } catch {
      amount = 0n;
    }
    if (amount === 0n) continue;

    const p = priceOf(tk.symbol, null, Number(tk.exchange_rate || 0));
    const usd = (Number(amount) / 10 ** decimals) * p.price;
    row.priceSources.add(p.source);

    if (to === w) {
      row.received.push({ symbol: tk.symbol || 'TOKEN', decimals, amount, usd, counterparty: from, isContract: tr.from && tr.from.is_contract, address: tk.address_hash });
    }
    if (from === w) {
      row.sent.push({ symbol: tk.symbol || 'TOKEN', decimals, amount, usd, counterparty: to, isContract: tr.to && tr.to.is_contract, address: tk.address_hash });
    }
  }

  const rows = [];
  for (const r of byTx.values()) {
    if (!r.sent.length && !r.received.length && r.feeWei === 0n) continue;

    const sentSum = r.sent.reduce((a, b) => a + b.usd, 0);
    const recvSum = r.received.reduce((a, b) => a + b.usd, 0);

    let type;
    if (r.received.length && r.sent.length) type = 'trade';
    else if (r.received.length) type = r.received.some((x) => x.isContract) ? 'income' : 'transfer_in';
    else if (r.sent.length) type = r.sent.every((x) => x.isContract) ? 'defi' : 'transfer_out';
    else type = 'fee';

    rows.push({
      date: isoToKoinly(r.timestamp),
      iso: r.timestamp,
      year: yearOf(r.timestamp),
      type,
      block: r.block,
      txHash: r.txHash,
      method: r.method || '',
      sent: r.sent,
      received: r.received,
      feeWei: r.feeWei,
      feeEth: Number(r.feeWei) / 1e18,
      feeUsd: r.feeUsd,
      netWorthUsd: recvSum - sentSum,
      priceSources: [...r.priceSources].filter(Boolean),
      description: describe(r),
    });
  }

  rows.sort((a, b) => new Date(a.iso) - new Date(b.iso));
  implySwapPrices(rows);
  return rows;
}

/**
 * In a swap the two legs are worth the same thing. When one leg has no market rate but the other
 * does, the unpriced leg's value is not unknown — it is whatever the priced leg paid. Back-filling
 * it turns "sent 0.01 ETH, received an unpriced token, net -$23" into a balanced trade, which is
 * what actually happened. Marked `implied` so it is never mistaken for an observed price.
 */
function implySwapPrices(rows) {
  for (const r of rows) {
    if (r.type !== 'trade') continue;
    const sentPriced = r.sent.filter((x) => x.usd > 0);
    const sentUnpriced = r.sent.filter((x) => !(x.usd > 0));
    const recvPriced = r.received.filter((x) => x.usd > 0);
    const recvUnpriced = r.received.filter((x) => !(x.usd > 0));

    let total = 0;
    let target = null;
    if (recvUnpriced.length && !recvPriced.length && sentPriced.length) {
      total = sentPriced.reduce((a, b) => a + b.usd, 0);
      target = recvUnpriced;
    } else if (sentUnpriced.length && !sentPriced.length && recvPriced.length) {
      total = recvPriced.reduce((a, b) => a + b.usd, 0);
      target = sentUnpriced;
    }
    if (!target || total <= 0) continue;

    const units = target.map((x) => Number(x.amount) / 10 ** x.decimals);
    const sumUnits = units.reduce((a, b) => a + b, 0);
    if (sumUnits <= 0) continue;

    target.forEach((x, i) => {
      x.usd = (units[i] / sumUnits) * total;
      x.implied = true;
    });
    r.priceSources = [...new Set([...r.priceSources.filter((s) => s !== 'unknown'), 'implied'])];
    r.netWorthUsd =
      r.received.reduce((a, b) => a + b.usd, 0) - r.sent.reduce((a, b) => a + b.usd, 0);
  }
}

function describe(r) {
  const parts = [];
  if (r.sent.length) parts.push('sent ' + r.sent.map((x) => `${fmtAmount(x.amount, x.decimals, 6)} ${x.symbol}`).join(' + '));
  if (r.received.length) parts.push('received ' + r.received.map((x) => `${fmtAmount(x.amount, x.decimals, 6)} ${x.symbol}`).join(' + '));
  if (r.method) parts.push(`method ${r.method}`);
  return parts.join('; ');
}

/** FIFO matching across the whole ledger, per asset. */
export function fifo(rows) {
  const lots = new Map(); // symbol -> [{amount: BigInt, decimals, unitCost, date}]
  const disposals = [];
  const unmatchedByAsset = new Map();
  const unpricedByAsset = new Map();
  let realized = 0;

  const pushLot = (symbol, amount, decimals, unitCost, date) => {
    if (!lots.has(symbol)) lots.set(symbol, []);
    lots.get(symbol).push({ amount, decimals, unitCost, date });
  };

  const consume = (symbol, amount, decimals, unitPrice, date, txHash) => {
    let remaining = amount;
    const queue = lots.get(symbol) || [];
    let basis = 0;
    let matchedAmt = 0n;

    while (remaining > 0n && queue.length) {
      const lot = queue[0];
      const take = lot.amount < remaining ? lot.amount : remaining;
      const scale = Number(take) / 10 ** decimals;
      basis += scale * lot.unitCost;
      matchedAmt += take;
      lot.amount -= take;
      remaining -= take;
      if (lot.amount === 0n) queue.shift();
    }

    // An asset sold before any lot was acquired is not a zero-quantity disposal: it is a disposal
    // whose cost basis sits outside the scanned window. Count it, never report it as zero.
    if (remaining > 0n) {
      const miss = Number(remaining) / 10 ** decimals;
      unmatchedByAsset.set(symbol, (unmatchedByAsset.get(symbol) || 0) + miss);
    }
    if (matchedAmt === 0n) return;

    // A disposal we cannot price must not be reported as a total loss. The lots are consumed —
    // the tokens did leave the wallet — but no gain is claimed and the row is flagged instead.
    if (!(unitPrice > 0)) {
      unpricedByAsset.set(symbol, (unpricedByAsset.get(symbol) || 0) + Number(matchedAmt) / 10 ** decimals);
      return;
    }

    const proceeds = (Number(matchedAmt) / 10 ** decimals) * unitPrice;
    const gain = proceeds - basis;
    realized += gain;
    disposals.push({
      date,
      asset: symbol,
      quantity: Number(matchedAmt) / 10 ** decimals,
      proceeds,
      costBasis: basis,
      gain,
      txHash,
      partial: remaining > 0n,
    });
  };

  for (const r of rows) {
    for (const x of r.received) {
      const unit = x.amount > 0n ? x.usd / (Number(x.amount) / 10 ** x.decimals) : 0;
      pushLot(x.symbol, x.amount, x.decimals, unit, r.date);
    }
    for (const x of r.sent) {
      const unit = x.amount > 0n ? x.usd / (Number(x.amount) / 10 ** x.decimals) : 0;
      consume(x.symbol, x.amount, x.decimals, unit, r.date, r.txHash);
    }
  }

  const open = [];
  for (const [symbol, queue] of lots) {
    for (const lot of queue) {
      if (lot.amount === 0n) continue;
      const qty = Number(lot.amount) / 10 ** lot.decimals;
      open.push({ symbol, quantity: qty, unitCost: lot.unitCost, value: qty * lot.unitCost, date: lot.date });
    }
  }

  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    disposals,
    realized,
    open,
    unmatched: sum(unmatchedByAsset),
    unmatchedByAsset: [...unmatchedByAsset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    unpriced: sum(unpricedByAsset),
    unpricedByAsset: [...unpricedByAsset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
}

// ---------- formatters for each target tool ----------

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (arr) => arr.map(csvCell).join(',');

export function toKoinly(rows) {
  const head = ['Date', 'Sent Amount', 'Sent Currency', 'Received Amount', 'Received Currency',
    'Fee Amount', 'Fee Currency', 'Net Worth Amount', 'Net Worth Currency', 'Label', 'Description', 'TxHash'];
  const out = [csvLine(head)];

  for (const r of rows) {
    const sent = r.sent.length ? r.sent : [{ symbol: '', amount: 0n, decimals: 18 }];
    const recv = r.received.length ? r.received : [{ symbol: '', amount: 0n, decimals: 18 }];
    const n = Math.max(sent.length, recv.length);
    for (let i = 0; i < n; i++) {
      const s = sent[i] || { symbol: '', amount: 0n, decimals: 18 };
      const v = recv[i] || { symbol: '', amount: 0n, decimals: 18 };
      out.push(csvLine([
        r.date,
        s.symbol ? fmtAmount(s.amount, s.decimals, 8) : '',
        s.symbol || '',
        v.symbol ? fmtAmount(v.amount, v.decimals, 8) : '',
        v.symbol || '',
        i === 0 && r.feeWei > 0n ? fmtAmount(r.feeWei, 18, 10) : '',
        i === 0 && r.feeWei > 0n ? 'ETH' : '',
        i === 0 ? r.netWorthUsd.toFixed(2) : '',
        i === 0 ? 'USD' : '',
        labelFor(r),
        i === 0 ? r.description : '',
        r.txHash,
      ]));
    }
  }
  return out.join('\n');
}

function labelFor(r) {
  if (r.type === 'trade') return '';
  if (r.type === 'income') return 'reward';
  if (r.type === 'transfer_in' || r.type === 'transfer_out') return 'transfer';
  if (r.type === 'defi') return 'trade';
  return '';
}

export function toCoinTracker(rows) {
  const head = ['Date', 'Received Quantity', 'Received Currency', 'Sent Quantity', 'Sent Currency',
    'Fee Amount', 'Fee Currency', 'Tag', 'Description'];
  const out = [csvLine(head)];
  for (const r of rows) {
    const sent = r.sent.map((x) => `${fmtAmount(x.amount, x.decimals, 8)} ${x.symbol}`).join(' + ');
    const recv = r.received.map((x) => `${fmtAmount(x.amount, x.decimals, 8)} ${x.symbol}`).join(' + ');
    const sentQty = r.sent.length === 1 ? fmtAmount(r.sent[0].amount, r.sent[0].decimals, 8) : '';
    const sentCur = r.sent.length === 1 ? r.sent[0].symbol : '';
    const recvQty = r.received.length === 1 ? fmtAmount(r.received[0].amount, r.received[0].decimals, 8) : '';
    const recvCur = r.received.length === 1 ? r.received[0].symbol : '';
    out.push(csvLine([
      r.date,
      recvQty,
      recvCur,
      sentQty,
      sentCur,
      r.feeWei > 0n ? fmtAmount(r.feeWei, 18, 10) : '',
      r.feeWei > 0n ? 'ETH' : '',
      r.type === 'income' ? 'airdrop' : r.type === 'transfer_in' || r.type === 'transfer_out' ? 'transfer' : '',
      (r.description + (sent && recv && (!sentQty || !recvQty) ? ` [${sent} -> ${recv}]` : '')).trim(),
    ]));
  }
  return out.join('\n');
}

export function toFlat(rows) {
  const head = ['Date', 'Type', 'Asset', 'Direction', 'Amount', 'USD Value', 'Counterparty',
    'Method', 'Fee ETH', 'Fee USD', 'Tx Hash', 'Block', 'Price Source'];
  const out = [csvLine(head)];
  for (const r of rows) {
    const legs = [
      ...r.sent.map((x) => ({ ...x, dir: 'out' })),
      ...r.received.map((x) => ({ ...x, dir: 'in' })),
    ];
    if (!legs.length) {
      out.push(csvLine([r.date, r.type, '', '', '', '', '', r.method, r.feeEth.toFixed(12), r.feeUsd.toFixed(4), r.txHash, r.block, r.priceSources.join('|')]));
      continue;
    }
    for (const l of legs) {
      out.push(csvLine([
        r.date, r.type, l.symbol, l.dir,
        fmtAmount(l.amount, l.decimals, 10),
        l.usd ? l.usd.toFixed(4) : '',
        l.counterparty || '',
        r.method,
        r.feeEth ? r.feeEth.toFixed(12) : '',
        r.feeUsd ? r.feeUsd.toFixed(4) : '',
        r.txHash, r.block, r.priceSources.join('|'),
      ]));
    }
  }
  return out.join('\n');
}

export function pnlRows(result) {
  const head = ['Disposed At', 'Asset', 'Quantity', 'Proceeds USD', 'Cost Basis USD', 'Gain USD', 'Tx Hash'];
  const out = [csvLine(head)];
  for (const d of result.disposals) {
    out.push(csvLine([d.date, d.asset, d.quantity.toFixed(8), d.proceeds.toFixed(2), d.costBasis.toFixed(2), d.gain.toFixed(2), d.txHash]));
  }
  return out.join('\n');
}

export function summarize(rows, result) {
  const byYear = new Map();
  let gasUsd = 0;
  for (const r of rows) {
    const y = r.year || 'unknown';
    if (!byYear.has(y)) byYear.set(y, { count: 0, volume: 0, gas: 0 });
    const b = byYear.get(y);
    b.count++;
    b.volume += Math.abs(r.netWorthUsd);
    b.gas += r.feeUsd;
    gasUsd += r.feeUsd;
  }
  return {
    count: rows.length,
    volume: [...byYear.values()].reduce((a, b) => a + b.volume, 0),
    gasUsd,
    realized: result ? result.realized : 0,
    openLots: result ? result.open.length : 0,
    openValue: result ? result.open.reduce((a, b) => a + b.value, 0) : 0,
    disposals: result ? result.disposals.length : 0,
    unmatched: result ? result.unmatched : 0,
    unmatchedByAsset: result ? result.unmatchedByAsset : [],
    unpriced: result ? result.unpriced : 0,
    unpricedByAsset: result ? result.unpricedByAsset : [],
    impliedRows: rows.filter((r) => r.priceSources.includes('implied')).length,
    unknownRows: rows.filter((r) => r.priceSources.includes('unknown')).length,
    byYear: [...byYear.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
}
