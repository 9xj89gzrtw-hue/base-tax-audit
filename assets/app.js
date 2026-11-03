import * as bs from './lib/blockscout.js';
import {
  buildTokenSet,
  coreTokenSet,
  discoverSpenders,
  readCoreBalances,
  runMatrix,
  withBalances,
} from './lib/approvals.js';
import { SPENDERS } from './lib/registry.js';
import { buildLedger, fifo, toKoinly, toCoinTracker, toFlat, summarize } from './lib/tax.js';
import { buildXlsx, download } from './lib/xlsx.js';
import { encApprove, formatUnits, shortAddr, rpc } from './lib/rpc.js';
import * as pay from './lib/pay.js';
import { PAY_TO, PRO_PRICE_USDC, CHAIN, EXPLORER_TX, EXPLORER_ADDR } from './lib/registry.js';

const FREE_ROWS = 50;
const PRO_ROWS = 10000;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  address: null,
  info: null,
  txs: [],
  transfers: [],
  approval: null,
  ledger: null,
  fifo: null,
  pro: false,
  license: null,
  deep: false,
  year: 'all',
  busy: false,
  taxReady: false,
  tokenIndex: null,
  indexerOk: {},
  timing: {},
};

// ---------- small helpers ----------

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const usd = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const compact = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(n < 1 ? 4 : 2);
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 3600);
}

function setStatus(text, kind = 'load') {
  const box = $('#status');
  const dot = kind === 'ok' ? 'ok-dot' : kind === 'err' ? 'err-dot' : 'spin';
  box.innerHTML = `<span class="${dot}"></span><span>${esc(text)}</span>`;
}

const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

/**
 * Show or clear an inline message in a panel without touching the table element.
 * Writing into the table wrapper's innerHTML would delete the <table>, which breaks
 * every later render — the slot keeps the DOM stable across re-scans.
 */
function setEmpty(kind, html) {
  const slot = $(`#empty-${kind}`);
  const wrap = $(`#wrap-${kind}`);
  if (!slot || !wrap) return;
  if (html) {
    slot.innerHTML = html;
    wrap.style.display = 'none';
  } else {
    slot.innerHTML = '';
    wrap.style.display = '';
  }
}

function renderPending(kind) {
  const label =
    kind === 'activity'
      ? 'Reading the transaction history from the indexer'
      : 'Reading token transfers to build the tax ledger';
  setEmpty(
    kind,
    `<div class="empty">
      <strong>${label}…</strong>
      The indexer is the slowest part of the scan. The risk answer above is already final.
    </div>`
  );
}

function renderTaxLoading() {
  setEmpty(
    'tax',
    `<div class="empty">
      <strong>Building the ledger from token transfers…</strong>
      This is the last step and usually takes a few seconds.
    </div>`
  );
}

function dayOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// ---------- scan ----------

async function scan(raw) {
  const addr = (raw || '').trim();
  if (!isAddress(addr)) {
    toast('That is not a valid 0x address.');
    return;
  }
  if (state.busy) return;
  state.busy = true;
  state.address = addr;
  state.deep = false;
  state.txs = [];
  state.transfers = [];
  state.approval = null;
  state.ledger = null;
  state.fifo = null;
  state.year = 'all';
  state.taxReady = false;
  window.__scanTiming = null;

  $('#addr').value = addr;
  $('#results').classList.add('on');
  $('#stats').innerHTML = '';
  $('#scanbtn').disabled = true;
  setStatus('Reading balances and allowances from Base');

  const t0 = performance.now();
  const mark = (label) => {
    state.timing[label] = Math.round(performance.now() - t0);
  };
  state.timing = {};

  try {
    // ---- wave 1: chain reads only, no indexer in the path -------------------
    // The allowance matrix needs nothing but the address, so it starts at once.
    // Balances come back from a single JSON-RPC batch in a few hundred milliseconds.
    const coreBalancesP = readCoreBalances(addr).catch(() => null);
    const coreMatrixP = runMatrix(addr, coreTokenSet(), SPENDERS);

    // ---- wave 2: the indexer, fetched in parallel and never blocking ---------
    // Each source reports its own success, because "the indexer said no tokens" and
    // "the indexer did not answer" look identical downstream but mean opposite things.
    const track = (p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, v: null, e }));
    const infoP = track(bs.addressInfo(addr));
    const balancesP = track(bs.tokenBalances(addr));
    const txsP = track(bs.transactions(addr, FREE_ROWS));
    const transfersP = track(bs.tokenTransfers(addr, FREE_ROWS));

    const coreBalances = await coreBalancesP;
    const core = await coreMatrixP;
    mark('risk');

    // First paint: balance and the risk answer, both straight from the chain.
    // Prices are not known yet, so USD fields show as pending rather than as zero —
    // a wrong $0 next to an unlimited approval would be worse than no number.
    state.approval = {
      rows: core.rows,
      ethBalance: coreBalances ? coreBalances.ethBalance : '0x0',
      ethPrice: 0,
      priced: false,
      matrix: { tokens: coreTokenSet().length, spenders: SPENDERS.length, checks: core.checks },
      tokens: coreBalances ? coreBalances.tokens : coreTokenSet(),
      complete: false,
    };
    if (coreBalances) applyBalances(coreBalances.tokens, 0);

    renderStats();
    renderApprovals();
    renderPending('activity');
    renderTaxLoading();

    const flagged = state.approval.rows.filter((r) => r.tier === 'unlimited').length;
    setStatus(
      flagged
        ? `${flagged} unlimited approval${flagged === 1 ? '' : 's'} found — loading activity and history`
        : 'No unlimited approvals on the blue-chip tokens — loading activity and history'
    );

    // ---- wave 3: widen to every token the wallet actually holds ------------
    // Only token balances and the price are needed here. The activity list is a separate
    // dependency and must not hold the risk answer hostage to a slower endpoint.
    const balRes = await balancesP;
    mark('balances');
    state.indexerOk = { balances: balRes.ok };
    const balances = balRes.ok ? balRes.v : [];

    const infoRes = await infoP;
    const info = infoRes.ok ? infoRes.v : null;
    state.info = info;
    const ethPrice = (info && Number(info.exchange_rate)) || 0;
    state.ethPrice = ethPrice;
    state.approval.ethPrice = ethPrice;
    state.approval.priced = ethPrice > 0;

    if (info && info.is_contract) {
      toast('That address is a contract, not a wallet — allowances are read with the contract as owner.');
    }

    const fullSet = buildTokenSet(balances);
    applyBalances(fullSet, ethPrice);

    const coreAddrs = new Set(coreTokenSet().map((t) => t.address.toLowerCase()));
    const extra = fullSet.filter((t) => !coreAddrs.has(t.address.toLowerCase()));

    if (extra.length) {
      const more = await runMatrix(addr, extra, SPENDERS);
      mark('widen');

      const seen = new Set(core.rows.map((r) => r.tokenAddress.toLowerCase() + r.spenderAddress.toLowerCase()));
      for (const r of more.rows) {
        const k = r.tokenAddress.toLowerCase() + r.spenderAddress.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          core.rows.push(r);
        }
      }
      state.approval.rows = core.rows;
      state.approval.matrix = {
        tokens: fullSet.length,
        spenders: SPENDERS.length,
        checks: core.checks + more.checks,
      };
    }
    // Only a successful token list lets us claim full coverage.
    state.approval.complete = balRes.ok;
    state.approval.widenFailed = !balRes.ok;

    applyBalances(fullSet, ethPrice);
    renderStats();
    renderApprovals();
    mark('riskFinal');

    const unlimited = state.approval.rows.filter((r) => r.tier === 'unlimited').length;
    if (!balRes.ok) {
      setStatus(
        'Scan limited — the indexer would not return this wallet\u2019s token list, so only blue-chip tokens were checked',
        'err'
      );
    } else {
      setStatus(
        unlimited
          ? `Scan complete — ${unlimited} unlimited approval${unlimited === 1 ? '' : 's'} found`
          : 'Scan complete — no unlimited approvals against the checked spenders',
        'ok'
      );
    }

    // ---- activity and the ledger arrive whenever the indexer is ready ------
    renderTaxLoading();
    const txsRes = await txsP;
    const txs = txsRes.ok ? txsRes.v : [];
    state.txs = txs;
    state.indexerOk.txs = txsRes.ok;
    mark('txs');
    renderActivity();
    renderStats();

    const trRes = await transfersP;
    state.transfers = trRes.ok ? trRes.v : [];
    state.indexerOk.transfers = trRes.ok;
    state.taxReady = true;
    mark('tax');
    rebuildLedger();
    renderStats();
    renderTax();
    window.__scanTiming = state.timing;
  } catch (e) {
    setStatus(e.message || 'Scan failed', 'err');
    toast('Scan failed. ' + (e.message || ''));
  } finally {
    state.busy = false;
    $('#scanbtn').disabled = false;
  }
}

/** Push fresh balances and USD prices onto the token set and onto any live approval rows. */
function applyBalances(tokens, ethPrice) {
  const index = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
  state.tokenIndex = index;
  if (!state.approval) return;
  state.approval.tokens = tokens;
  if (ethPrice > 0) state.approval.ethPrice = ethPrice;
  withBalances(state.approval.rows, index);
}

function rebuildLedger() {
  state.ledger = buildLedger({
    wallet: state.address,
    txs: state.txs,
    transfers: state.transfers,
  });
  state.fifo = state.ledger.length ? fifo(state.ledger) : null;
}

// ---------- render: stats ----------

function renderStats() {
  const a = state.approval;
  if (!a) return;
  const eth = Number(a.ethBalance) / 1e18;
  const priced = !!a.priced;
  const ethUsd = eth * (a.ethPrice || 0);

  const balances = a.tokens.filter((t) => t.held);
  const tokenUsd = balances.reduce((s, t) => s + (t.usd || 0), 0);

  const unlimited = a.rows.filter((r) => r.tier === 'unlimited');
  const atRisk = a.rows.reduce((s, r) => s + r.usdAtRisk, 0);
  const sum = summarize(state.ledger || [], state.fifo);

  const money = (v) => (priced ? usd(v) : '<span class="skeleton" style="width:64px;height:20px"></span>');

  $('#stats').innerHTML = `
    <div class="stat">
      <div class="k">Balance</div>
      <div class="v">${money(ethUsd + tokenUsd)}</div>
      <div class="s">${eth ? eth.toFixed(5) + ' ETH' : '0 ETH'} · ${balances.length} token${balances.length === 1 ? '' : 's'}</div>
    </div>
    <div class="stat ${unlimited.length ? 'alert' : ''}">
      <div class="k">Unlimited approvals</div>
      <div class="v">${unlimited.length}</div>
      <div class="s">${a.rows.length} active of ${a.matrix.checks} checked</div>
    </div>
    <div class="stat ${atRisk > 1 ? 'alert' : ''}">
      <div class="k">Exposed right now</div>
      <div class="v">${money(atRisk)}</div>
      <div class="s">balance a spender can move</div>
    </div>
    <div class="stat">
      <div class="k">Transactions read</div>
      <div class="v">${state.txs.length || sum.count}</div>
      <div class="s">${sum.gasUsd ? usd(sum.gasUsd) + ' gas' : 'gas pending'}</div>
    </div>`;
}

// ---------- render: approvals ----------

function riskPill(tier) {
  if (tier === 'unlimited') return '<span class="pill pill-danger">Unlimited</span>';
  if (tier === 'high') return '<span class="pill pill-warn">Very high</span>';
  return '<span class="pill pill-mute">Limited</span>';
}

function allowanceText(row) {
  if (row.tier === 'unlimited') return 'Unlimited';
  return compact(Number(row.allowance) / 10 ** row.tokenDecimals) + ' ' + row.token;
}

function renderApprovals() {
  const a = state.approval;
  if (!a) return;
  const tbody = $('#tbl-approvals tbody');
  $('#c-approvals').textContent = a.rows.length;
  $('#matrix').textContent = a.complete
    ? `${a.matrix.tokens} tokens × ${a.matrix.spenders} spenders = ${a.matrix.checks} allowance reads`
    : a.widenFailed
      ? `${a.matrix.tokens} blue-chip tokens checked · full token list unavailable`
      : `${a.matrix.tokens} blue-chip tokens checked · widening to everything the wallet holds`;

  if (!a.rows.length) {
    tbody.innerHTML = '';
    setEmpty(
      'approvals',
      `<div class="empty">
        <strong>No active approvals against the checked spenders.</strong>
        Every one of the ${a.matrix.checks} allowance reads came back zero. That is the good outcome —
        nothing this wallet holds can be pulled by a known Base router, aggregator or marketplace.
      </div>`
    );
  } else {
    setEmpty('approvals', null);
    let freeRevokeUsed = false;
    tbody.innerHTML = a.rows
      .map((r, i) => {
        const isHigh = r.tier !== 'limited';
        let action;
        if (state.pro) {
          action = `<button class="btn btn-sm btn-danger" data-revoke="${i}" title="Sends approve(spender, 0) from this wallet. Gas only, no fee to us.">Revoke in 1 Click</button>`;
        } else if (isHigh && !freeRevokeUsed) {
          freeRevokeUsed = true;
          action = `<button class="btn btn-sm btn-danger" data-revoke="${i}" title="Free, right from this page: one approve(spender, 0) transaction. Gas only.">Revoke in 1 Click <span class="pill pill-mute" style="margin-left:4px">free</span></button>`;
        } else if (isHigh) {
          action = `<button class="btn btn-sm" data-unlock="1" title="One free revoke per scan. Pro removes the limit and adds batch revoke.">Revoke in 1 Click · Pro</button>`;
        } else {
          action = `<button class="btn btn-sm btn-ghost" data-revoke="${i}" title="Sends approve(spender, 0) from this wallet.">Revoke in 1 Click</button>`;
        }
        return `<tr>
          <td><span class="pill pill-accent">${esc(r.token)}</span></td>
          <td>
            <div style="font-weight:500">${esc(r.spender)}</div>
            <div class="addr">${esc(shortAddr(r.spenderAddress, 8, 6))}</div>
          </td>
          <td><span class="pill pill-mute">${esc(r.spenderKind)}</span></td>
          <td class="num right">${esc(allowanceText(r))}</td>
          <td>${riskPill(r.tier)}</td>
          <td class="num right">${r.usdAtRisk ? usd(r.usdAtRisk) : '—'}</td>
          <td class="right">${action}</td>
        </tr>`;
      })
      .join('');
  }

  const high = a.rows.filter((r) => r.tier !== 'limited');
  const coverage = a.complete
    ? `for ${a.matrix.tokens} tokens against ${a.matrix.spenders} spenders.`
    : `for the ${a.matrix.tokens} blue-chip tokens only — the indexer did not return this wallet\u2019s full token list, so holdings outside that set were not checked.`;

  $('#approvalsnote').innerHTML = `
    <strong>${a.rows.length} active approval${a.rows.length === 1 ? '' : 's'}</strong> found by reading
    <code>allowance(owner, spender)</code> ${coverage}
    ${high.length ? `Revoking sends <code>approve(spender, 0)</code> from this wallet — it costs gas and nothing else.
    <b>Revoke in 1 Click</b> is free for the first high-risk row of every scan; the rest of the list and the
    one-signature-per-row batch are what Pro is for.` : ''}
    An approval granted to a contract this wallet never interacted with directly is outside this check.`;

  $('#approvalsnote').classList.toggle('warn', !a.complete);

  $('#batchrevoke').disabled = false;
  $('#batchrevoke').classList.toggle('is-locked', !state.pro);
  $('#batchrevoke').textContent = state.pro
    ? `Batch Revoke All ${high.length} Risky Approvals`
    : `Batch Revoke All Risky Approvals (Pro $9)`;
  $('#batchrevoke').title = state.pro
    ? 'One wallet prompt per approval, each approve(spender, 0). Reject any prompt to stop.'
    : 'Pro unlocks the sequence: every risky approval revoked back to back. Free users still get one revoke in 1 click per scan.';
}

// ---------- render: activity ----------

function renderActivity() {
  const txs = state.txs || [];
  $('#c-activity').textContent = txs.length;
  const tbody = $('#tbl-activity tbody');
  const w = (state.address || '').toLowerCase();

  if (!txs.length) {
    tbody.innerHTML = '';
    setEmpty(
      'activity',
      `<div class="empty">
        <strong>No transactions indexed for this address.</strong>
        It may be a fresh wallet, or an address that has never sent on Base.
      </div>`
    );
  } else {
    setEmpty('activity', null);
    tbody.innerHTML = txs
      .map((t) => {
        const from = t.from && t.from.hash ? t.from.hash : '';
        const to = t.to && t.to.hash ? t.to.hash : '';
        const outgoing = from.toLowerCase() === w;
        const other = outgoing ? to : from;
        const value = Number(BigInt(t.value || '0')) / 1e18;
        const fee = t.fee && t.fee.value ? Number(BigInt(t.fee.value)) / 1e18 : 0;
        const rate = Number(t.historic_exchange_rate || t.exchange_rate || 0);
        const type = t.token_transfers && t.token_transfers.length ? 'Token' : value > 0 ? 'ETH' : 'Contract';
        return `<tr>
          <td class="num">${esc(dayOf(t.timestamp))}</td>
          <td><span class="pill ${outgoing ? 'pill-mute' : 'pill-ok'}">${outgoing ? 'Out' : 'In'} ${type}</span></td>
          <td><code style="font-size:12.5px">${esc(t.method || '—')}</code></td>
          <td class="addr">${other ? esc(shortAddr(other, 8, 6)) : '<span style="color:var(--text-3)">contract creation</span>'}</td>
          <td class="num right">${value ? value.toFixed(5) + ' ETH' : '—'}${value && rate ? `<div style="font-size:11px;color:var(--text-3)">${usd(value * rate)}</div>` : ''}</td>
          <td class="num right">${fee ? fee.toFixed(6) : '—'}</td>
          <td class="right"><a href="${EXPLORER_TX(t.hash)}" target="_blank" rel="noopener" style="font-size:12.5px">Open</a></td>
        </tr>`;
      })
      .join('');
  }

  const failed = state.indexerOk && state.indexerOk.txs === false;
  $('#activitynote').innerHTML = failed
    ? `<strong>The indexer did not answer for this address.</strong> The list below is empty because the request failed, not because the wallet has no transactions. Scan again to retry.`
    : state.deep
      ? `<strong>Full history loaded:</strong> ${txs.length.toLocaleString('en-US')} transactions.`
      : `<strong>Showing the ${txs.length} most recent transactions.</strong> The full history is part of Pro and is paginated on demand.`;
  $('#activitynote').classList.toggle('warn', !!failed);
}

// ---------- render: tax ----------

function rowsForYear() {
  const all = state.ledger || [];
  if (state.year === 'all') return all;
  return all.filter((r) => String(r.year) === String(state.year));
}

function renderTax() {
  const all = state.ledger || [];
  $('#c-tax').textContent = all.length;

  const years = [...new Set(all.map((r) => r.year).filter(Boolean))].sort();
  const sel = $('#year');
  const prev = state.year;
  sel.innerHTML =
    `<option value="all">All (${all.length})</option>` +
    years.map((y) => `<option value="${y}">${y} (${all.filter((r) => r.year === y).length})</option>`).join('');
  sel.value = years.map(String).includes(String(prev)) || prev === 'all' ? prev : 'all';
  state.year = sel.value;

  const rows = rowsForYear();
  const tbody = $('#tbl-tax tbody');

  if (!rows.length) {
    tbody.innerHTML = '';
    setEmpty(
      'tax',
      `<div class="empty">
        <strong>Nothing to export for this selection.</strong>
        No indexed movements were found in the chosen year.
      </div>`
    );
  } else {
    setEmpty('tax', null);
    tbody.innerHTML = rows
      .slice(0, 200)
      .map((r) => {
        const sent = r.sent.map((x) => `${formatUnits(x.amount, x.decimals)} ${x.symbol}`).join(' + ');
        const recv = r.received.map((x) => `${formatUnits(x.amount, x.decimals)} ${x.symbol}`).join(' + ');
        const net = r.netWorthUsd;
        // The split date is only used by the card layout on a phone, where the row is not a table.
        const dateCell = esc(r.date || '');
        return `<tr>
          <td class="num" data-label="Date">${dateCell}</td>
          <td data-label="Type"><span class="pill pill-mute">${esc(r.type)}</span></td>
          <td class="num" data-label="Sent">${esc(sent || '—')}</td>
          <td class="num" data-label="Received">${esc(recv || '—')}</td>
          <td class="num right" data-label="Fee">${r.feeEth ? r.feeEth.toFixed(6) : '—'}</td>
          <td class="num right" data-label="Net" style="color:${net < 0 ? 'var(--danger)' : 'inherit'}">${r.type === 'trade' || net ? usd(net) : '—'}</td>
          <td data-label="Priced by"><span class="pill pill-mute" style="font-size:10.5px">${esc(r.priceSources.join('+') || '—')}</span></td>
        </tr>`;
      })
      .join('');
  }

  const sum = summarize(rows, state.year === 'all' ? state.fifo : null);
  const truncated = rows.length > 200;
  const cap = state.pro ? PRO_ROWS : FREE_ROWS;
  const caveats = [];
  if (sum.impliedRows) caveats.push(`${sum.impliedRows} swap row${sum.impliedRows === 1 ? '' : 's'} valued from the other side of the trade`);
  if (sum.unpriced) caveats.push(`${sum.unpriced.toFixed(2)} units disposed at no market rate — excluded from gains, not written off`);
  if (sum.unmatched) caveats.push(`${sum.unmatched.toFixed(2)} units disposed with no matching purchase inside the scanned window`);

  const trFailed = state.indexerOk && state.indexerOk.transfers === false;
  $('#taxnote').innerHTML = trFailed
    ? `<strong>The indexer did not return token transfers for this address.</strong>
       The ledger below is built from native transactions only, so token movements are missing.
       That makes any gain figure wrong, not merely incomplete. Scan again to retry.`
    : `
    <strong>${rows.length} rows${state.year !== 'all' ? ` in ${state.year}` : ''}</strong>,
    ${usd(sum.gasUsd)} of gas, ${usd(sum.volume)} of movement.
    ${truncated ? 'The table shows the first 200 rows; the export contains all of them.' : ''}
    ${state.pro
      ? `Realised FIFO gain: <strong>${usd(sum.realized)}</strong> across ${sum.disposals} disposals.
         Open lots: ${sum.openLots} (${usd(sum.openValue)}).
         ${caveats.length ? `<br><br><strong>Read this before filing.</strong> ${esc(caveats.join('. '))}. A disposal whose purchase falls outside the scanned window has no cost basis here — pull the full history before relying on the gain figure.` : ''}`
      : `Free exports are capped at the first ${cap} rows. Pro lifts the cap to ${PRO_ROWS.toLocaleString('en-US')} and adds FIFO cost basis, XLSX and batch revoke.`}`;
  $('#taxnote').classList.toggle('warn', !!trFailed);
  $('#deepexportbtn').textContent = state.deep ? 'Reload full history' : 'Full history (Pro)';
}

// ---------- revoke ----------

async function revokeOne(row) {
  if (!pay.hasProvider()) {
    toast('Install MetaMask, Rabby or Coinbase Wallet to send the revoke transaction.');
    return;
  }
  try {
    await pay.ensureBase();
    const from = await pay.connect();
    setStatus(`Waiting for signature to revoke ${row.token} → ${row.spender}`);
    const hash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: row.tokenAddress, data: encApprove(row.spenderAddress, 0n), value: '0x0' }],
    });
    toast('Revoke sent. Waiting for the receipt.');
    const receipt = await waitForReceipt(hash);
    if (receipt && receipt.status === '0x1') {
      setStatus(`Revoked ${row.token} → ${row.spender}`, 'ok');
      toast('Approval revoked.');
      await rescanApprovals();
    } else {
      setStatus('The revoke transaction did not succeed', 'err');
    }
  } catch (e) {
    setStatus('Revoke cancelled or failed', 'err');
    toast(e.message || 'Revoke failed');
  }
}

async function waitForReceipt(hash, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

async function rescanApprovals() {
  if (!state.address) return;
  setStatus('Re-reading allowances');
  const tokens = state.tokenIndex ? [...state.tokenIndex.values()] : coreTokenSet();
  const spenders = [...SPENDERS.map((s) => ({ ...s })), ...discoverSpenders(state.txs, state.address)];
  const { rows, checks } = await runMatrix(state.address, tokens, spenders);
  state.approval.rows = withBalances(rows, state.tokenIndex || new Map());
  state.approval.matrix = { tokens: tokens.length, spenders: spenders.length, checks };
  renderStats();
  renderApprovals();
  setStatus('Allowances refreshed', 'ok');
}

async function batchRevoke() {
  const high = state.approval.rows.filter((r) => r.tier !== 'limited');
  if (!high.length) {
    toast('There is nothing high-risk to revoke.');
    return;
  }
  if (!pay.hasProvider()) {
    toast('Install MetaMask, Rabby or Coinbase Wallet to send these transactions.');
    return;
  }
  try {
    await pay.ensureBase();
    const from = await pay.connect();
    let done = 0;
    for (const row of high) {
      setStatus(`Revoking ${done + 1} of ${high.length}: ${row.token} → ${row.spender}`);
      try {
        const hash = await window.ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: row.tokenAddress, data: encApprove(row.spenderAddress, 0n), value: '0x0' }],
        });
        const receipt = await waitForReceipt(hash);
        if (receipt && receipt.status === '0x1') done++;
      } catch (e) {
        // a rejected prompt stops the sequence; anything else is reported and skipped
        if (e && (e.code === 4001 || /reject/i.test(e.message || ''))) throw e;
        toast(`Skipped ${row.token} → ${row.spender}`);
      }
    }
    setStatus(`Revoked ${done} of ${high.length} approvals`, 'ok');
    toast(`${done} approvals revoked.`);
    await rescanApprovals();
  } catch (e) {
    setStatus('Batch revoke stopped', 'err');
    toast(e.message || 'Batch revoke stopped');
  }
}

function copyCalldata() {
  const rows = state.approval ? state.approval.rows.filter((r) => r.tier !== 'limited') : [];
  if (!rows.length) {
    toast('No high-risk approvals to encode.');
    return;
  }
  const list = rows.map((r) => ({
    to: r.tokenAddress,
    data: encApprove(r.spenderAddress, 0n),
    description: `approve(${r.spender}, 0) — ${r.token}`,
  }));
  const text = JSON.stringify(list, null, 2);
  navigator.clipboard
    .writeText(text)
    .then(() => toast(`${list.length} approve(spender, 0) transactions copied.`))
    .catch(() => toast('Clipboard blocked by the browser.'));
}

// ---------- export ----------

async function exportNow() {
  const fmt = $('#format').value;
  let rows = rowsForYear();
  const cap = state.pro ? PRO_ROWS : FREE_ROWS;

  if (!rows.length) {
    toast('There is nothing to export yet.');
    return;
  }

  const sliced = rows.slice(0, cap);
  const stamp = new Date().toISOString().slice(0, 10);
  const who = state.address.slice(0, 10);
  const suffix = state.year === 'all' ? 'all' : state.year;
  const limited = rows.length > sliced.length;

  try {
    if (fmt === 'xlsx') {
      if (!state.pro) return openPay('Excel export is part of Pro. The CSV formats are free up to 50 rows.');
      const sum = summarize(sliced, state.fifo);
      const pnl = state.fifo || { disposals: [], open: [] };

      const ledgerRows = [
        ['Date', 'Type', 'Sent', 'Sent Amount', 'Received', 'Received Amount', 'Fee ETH', 'Fee USD', 'Net USD', 'Method', 'Price Source', 'Tx Hash', 'Block'],
      ];
      for (const r of sliced) {
        const sent = r.sent[0] || {};
        const recv = r.received[0] || {};
        ledgerRows.push([
          r.date, r.type,
          sent.symbol || '', sent.symbol ? Number(formatUnits(sent.amount, sent.decimals)) : '',
          recv.symbol || '', recv.symbol ? Number(formatUnits(recv.amount, recv.decimals)) : '',
          r.feeEth ? Number(r.feeEth.toFixed(12)) : '',
          r.feeUsd ? Number(r.feeUsd.toFixed(4)) : '',
          Number(r.netWorthUsd.toFixed(2)),
          r.method, r.priceSources.join('+'), r.txHash, r.block,
        ]);
      }

      const pnlSheet = [
        ['Disposed At', 'Asset', 'Quantity', 'Proceeds USD', 'Cost Basis USD', 'Gain USD', 'Tx Hash'],
        ...pnl.disposals.map((d) => [d.date, d.asset, Number(d.quantity.toFixed(8)), Number(d.proceeds.toFixed(2)), Number(d.costBasis.toFixed(2)), Number(d.gain.toFixed(2)), d.txHash]),
      ];

      const openSheet = [
        ['Acquired', 'Asset', 'Quantity', 'Unit Cost USD', 'Cost Basis USD'],
        ...pnl.open.map((l) => [l.date, l.symbol, Number(l.quantity.toFixed(8)), Number(l.unitCost.toFixed(6)), Number(l.value.toFixed(2))]),
      ];

      const summarySheet = [
        ['Metric', 'Value'],
        ['Wallet', state.address],
        ['Generated', new Date().toISOString()],
        ['Period', state.year === 'all' ? 'all indexed' : String(state.year)],
        ['Transactions', sum.count],
        ['Gas paid, USD', Number(sum.gasUsd.toFixed(2))],
        ['Realised FIFO gain, USD', Number(sum.realized.toFixed(2))],
        ['Open lots', sum.openLots],
        ['Open cost basis, USD', Number(sum.openValue.toFixed(2))],
        ...sum.byYear.map(([y, b]) => [`${y}: transactions / gas USD`, `${b.count} / ${b.gas.toFixed(2)}`]),
        ['Price sources', 'stablecoins $1.00; ETH/WETH historic per transaction; other ERC-20 current spot'],
      ];

      const blob = buildXlsx([
        { name: 'Ledger', rows: ledgerRows },
        { name: 'Realised PnL', rows: pnlSheet },
        { name: 'Open Lots', rows: openSheet },
        { name: 'Summary', rows: summarySheet },
      ]);
      download(`base-tax-${who}-${suffix}-${stamp}.xlsx`, blob);
    } else if (fmt === 'koinly') {
      download(`base-koinly-${who}-${suffix}-${stamp}.csv`, toKoinly(sliced));
    } else if (fmt === 'cointracker') {
      download(`base-cointracker-${who}-${suffix}-${stamp}.csv`, toCoinTracker(sliced));
    } else {
      download(`base-ledger-${who}-${suffix}-${stamp}.csv`, toFlat(sliced));
    }

    toast(limited ? `Exported ${sliced.length} of ${rows.length} rows — Pro lifts the cap.` : `Exported ${sliced.length} rows.`);
  } catch (e) {
    toast('Export failed: ' + (e.message || ''));
  }
}

async function deepExport() {
  if (!state.pro) return openPay('The full-history pull is part of Pro.');
  if (!state.address || state.busy) return;
  state.busy = true;
  $('#deepexportbtn').disabled = true;
  setStatus('Pulling the full transaction history — this takes about a minute');

  try {
    const [txs, transfers] = await Promise.all([
      bs.transactions(state.address, PRO_ROWS, (n) => setStatus(`Transactions: ${n.toLocaleString('en-US')} loaded`)),
      bs.tokenTransfers(state.address, PRO_ROWS, (n) => setStatus(`Token transfers: ${n.toLocaleString('en-US')} loaded`)),
    ]);
    state.txs = txs;
    state.transfers = transfers;
    state.deep = true;
    rebuildLedger();
    renderStats();
    renderActivity();
    renderTax();
    setStatus(`Full history loaded — ${txs.length.toLocaleString('en-US')} transactions, ${transfers.length.toLocaleString('en-US')} token transfers`, 'ok');
  } catch (e) {
    setStatus('Full-history pull failed', 'err');
    toast(e.message || 'Pull failed');
  } finally {
    state.busy = false;
    $('#deepexportbtn').disabled = false;
  }
}

// ---------- payment ----------

function openPay(reason) {
  if (reason) $('#modal-body').textContent = reason;
  else
    $('#modal-body').textContent =
      `Send ${PRO_PRICE_USDC} USDC on Base to the address below, then paste the transaction hash. It is verified on-chain in the browser, so there is nothing to sign up for.`;
  $('#payto').textContent = PAY_TO;
  $('#paymodal').classList.add('on');
  $('#txhash').value = '';

  // Show what the wallet can actually do, instead of promising a button that will fail.
  const hasWallet = pay.hasProvider();
  $('#modal-pay').style.display = hasWallet ? '' : 'none';
  $('#nosupport').style.display = hasWallet ? 'none' : '';
  const line = $('#walletline');
  const manual = $('.manualpay');
  if (!hasWallet) {
    line.textContent = 'No browser wallet detected in this browser.';
    if (manual) manual.open = true;
    return;
  }
  line.textContent = 'Checking your wallet on Base…';
  (async () => {
    try {
      const from = await pay.connect();
      const { usdc, eth } = await pay.preflight(from);
      const parts = [shortAddr(from)];
      parts.push(usdc === null ? 'USDC balance unreadable' : `${(Number(usdc) / 1e6).toFixed(2)} USDC`);
      if (eth === 0n) parts.push('no ETH for gas');
      line.textContent = parts.join(' · ');
      const gap = pay.shortfall({ usdc });
      if (gap) {
        line.textContent += ' — short of the price';
        $('#modal-body').textContent = gap;
      }
    } catch (e) {
      line.textContent = 'Wallet connected, but it did not share an account.';
    }
  })();
}

function closePay() {
  $('#paymodal').classList.remove('on');
}

async function unlockWith(hash) {
  $('#modal-verify').disabled = true;
  $('#modal-verify').textContent = 'Verifying';
  try {
    const v = await pay.verifyPayment(hash);
    if (!v.ok) {
      toast(v.reason);
      return;
    }
    pay.saveLicense({ txHash: hash, paid: v.paid, block: v.block, at: new Date().toISOString() });
    state.pro = true;
    state.license = { txHash: hash };
    applyLicense();
    closePay();
    toast(`Unlocked. ${v.paid} USDC verified at block ${v.block}.`);
  } catch (e) {
    toast('Verification failed: ' + (e.message || ''));
  } finally {
    $('#modal-verify').disabled = false;
    $('#modal-verify').textContent = 'Verify and unlock';
  }
}

async function payWithWallet() {
  if (!pay.hasProvider()) {
    toast('No browser wallet detected. Send 9 USDC on Base manually, then paste the hash.');
    return;
  }
  const btn = $('#modal-pay');
  btn.disabled = true;
  try {
    const from = await pay.connect();
    const { usdc, eth } = await pay.preflight(from);
    const gap = pay.shortfall({ usdc });
    if (gap) {
      toast(gap);
      if ($('#paymodal').classList.contains('on')) $('#modal-body').textContent = gap;
      return;
    }
    if (eth === 0n) toast('No ETH on Base for gas — the wallet may refuse this transfer.');
    const hash = await pay.payPro(from);
    toast('Payment sent. Confirming on Base.');
    await waitForReceipt(hash);
    await unlockWith(hash);
  } catch (e) {
    toast(e.message || 'Payment cancelled');
  } finally {
    btn.disabled = false;
  }
}

/**
 * The pricing button is the whole funnel: one click, one signature, no form.
 * The sheet only appears when there is no wallet, or when a gated feature asks for Pro.
 */
function startPurchase(reason) {
  if (reason || !pay.hasProvider()) return openPay(reason);
  return payWithWallet();
}

function applyLicense() {
  const btn = $('#licensestate');
  btn.textContent = state.pro ? 'Pro unlocked' : 'Free tier';
  if (state.pro) {
    btn.style.background = 'var(--ok-soft)';
    btn.style.color = 'var(--ok)';
    btn.style.borderColor = '#a7f3d0';
  }
  if (state.approval) renderApprovals();
  if (state.ledger) renderTax();
  $('#buybtn').textContent = state.pro ? 'Pro is unlocked' : `Pay $${PRO_PRICE_USDC} in USDC`;
  $('#buybtn').disabled = state.pro;
}

// ---------- wiring ----------

function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      $$('.panel').forEach((p) => p.classList.remove('on'));
      const name = tab.dataset.tab;
      $(`#panel-${name}`).classList.add('on');
    });
  });
}

function init() {
  initTabs();

  $('#scanform').addEventListener('submit', (e) => {
    e.preventDefault();
    scan($('#addr').value);
  });

  $$('[data-addr]').forEach((b) => {
    b.addEventListener('click', () => {
      $('#addr').value = b.dataset.addr;
      scan(b.dataset.addr);
    });
  });

  document.addEventListener('click', (e) => {
    const rev = e.target.closest('[data-revoke]');
    if (rev) {
      const row = state.approval.rows[Number(rev.dataset.revoke)];
      if (row) revokeOne(row);
      return;
    }
    const unlock = e.target.closest('[data-unlock]');
    if (unlock) startPurchase('Pro lifts the one-free-revoke limit and adds batch revoke for the whole list.');
  });

  $('#copycalldata').addEventListener('click', copyCalldata);
  $('#batchrevoke').addEventListener('click', () => (state.pro
    ? batchRevoke()
    : startPurchase('Batch revoke is Pro: one prompt per approval, every risky approval in the list, back to back. One revoke in 1 click stays free.')));
  $('#exportbtn').addEventListener('click', exportNow);
  $('#deepexportbtn').addEventListener('click', deepExport);
  $('#year').addEventListener('change', (e) => {
    state.year = e.target.value;
    renderTax();
  });
  $('#buybtn').addEventListener('click', () => startPurchase());
  $('#freefocus').addEventListener('click', () => {
    $('#addr').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#licensestate').addEventListener('click', () => (state.pro ? toast('Pro is active on this device.') : startPurchase()));

  $('#modal-cancel').addEventListener('click', closePay);
  $('#modal-verify').addEventListener('click', () => unlockWith($('#txhash').value.trim()));
  $('#modal-pay').addEventListener('click', payWithWallet);
  $('#paymodal').addEventListener('click', (e) => {
    if (e.target.id === 'paymodal') closePay();
  });

  // restore a licence, then re-check it against Base
  const saved = pay.loadLicense();
  if (saved && saved.txHash) {
    state.pro = true;
    state.license = saved;
    applyLicense();
    pay.revalidate(saved).then((ok) => {
      if (!ok) {
        state.pro = false;
        pay.clearLicense();
        applyLicense();
        toast('The stored licence did not verify against Base and was cleared.');
      }
    });
  } else {
    applyLicense();
  }

  // a deep link can preload an address: ?address=0x…
  const q = new URLSearchParams(location.search).get('address');
  if (q && isAddress(q)) {
    $('#addr').value = q;
    scan(q);
  }
}

document.addEventListener('DOMContentLoaded', init);

export { scan };
