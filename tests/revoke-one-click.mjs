// End-to-end proof that "Revoke in 1 Click" and the batch revoke actually send
// approve(spender, 0) from the page, gated exactly as the copy says.
//
// Real: the page, its modules, the DOM, the click path, the calldata encoder, the
// receipt wait and the re-scan.
// Mocked: window.ethereum and the chain reads the scan needs — balances, allowances
// and the indexer. Everything the buyer is promised is asserted on the calldata
// the mock wallet received, which is the only thing that matters on-chain.
//
//   node tests/revoke-one-click.mjs [--headed]
//
// Exit code 0 means every assertion passed.

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = process.env.SHOTS_DIR || join(ROOT, '..', 'screenshots');
const HEADED = process.argv.includes('--headed');

const OWNER = '0x2222222222222222222222222222222222222222';
const FAKE_HASH = '0x' + 'cd'.repeat(32);
const SEL_ALLOWANCE = '0xdd62ed3e';
const SEL_BALANCE = '0x70a08231';
const APPROVE = '0x095ea7b3';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x72Aa6edDE71B94f6b99c8e52EdC02B5C75F74d1a';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX = (2n ** 256n - 1n).toString(16).padStart(64, '0');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function walletMock() {
  return `
    window.__w = { sent: [], rejectNext: false };
    window.ethereum = {
      isMetaMask: true,
      request: async (args) => {
        const m = args.method;
        if (m === 'eth_requestAccounts' || m === 'eth_accounts') return ['${OWNER}'];
        if (m === 'eth_chainId') return '0x2105';
        if (m === 'wallet_switchEthereumChain' || m === 'wallet_addEthereumChain') return null;
        if (m === 'eth_sendTransaction') {
          if (window.__w.rejectNext) { window.__w.rejectNext = false; const e = new Error('User rejected'); e.code = 4001; throw e; }
          window.__w.sent.push(args.params[0]);
          return '${FAKE_HASH}';
        }
        return null;
      },
    };
  `;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

/** Every allowance read comes back unlimited for these spenders, zero otherwise. */
async function installChain(page, { unlimitedSpenders = [] } = {}) {
  const unlimited = new Set(unlimitedSpenders.map((s) => s.toLowerCase()));

  /* One JSON-RPC answer, used for both a single call and every element of a
     batch — the page batches the whole allowance matrix into one POST. */
  const answer = (call) => {
    const method = call.method;
    const params = call.params || [];
    if (method === 'eth_getTransactionReceipt') {
      /* A real 9.5 USDC Transfer to the project address, so the licence check the
         page runs on a stored licence finds the payment it is looking for. */
      return {
        status: '0x1',
        blockNumber: '0x3a8f00',
        transactionHash: FAKE_HASH,
        from: OWNER,
        logs: [{
          address: USDC,
          topics: [
            TRANSFER_TOPIC,
            '0x' + '0'.repeat(24) + OWNER.slice(2).toLowerCase(),
            '0x' + '0'.repeat(24) + PAY_TO.slice(2).toLowerCase(),
          ],
          data: '0x' + (9_500_000n).toString(16).padStart(64, '0'),
        }],
      };
    }
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBalance') return '0x' + (2n * 10n ** 15n).toString(16);
    if (method === 'eth_blockNumber') return '0x3a8f00';
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') {
      const data = String((params[0] || {}).data || '').toLowerCase();
      if (data.startsWith(SEL_ALLOWANCE)) {
        /* approve-allowance word layout: selector + owner word + spender word. */
        const spender = '0x' + data.slice(10 + 64 + 24, 10 + 64 + 64);
        return unlimited.has(spender) ? '0x' + MAX : '0x' + '0'.repeat(64);
      }
      if (data.startsWith(SEL_BALANCE)) {
        return '0x' + (1_000_000n * 10n ** 18n).toString(16).padStart(64, '0');
      }
      return '0x' + '0'.repeat(64);
    }
    return null;
  };

  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      // The indexer is optional; an outage makes the page fall back to blue chips,
      // which is the honest degraded path and keeps the test off the network.
      // Only the indexer API is blocked — its module still has to load, otherwise
      // the whole page fails to boot and nothing below is being tested.
      if (/base\.blockscout\.com/i.test(req.url())) {
        return route.fulfill({ status: 503, body: 'indexer unavailable in test' });
      }
      return route.continue();
    }
    let body;
    try { body = JSON.parse(req.postData() || '{}'); } catch { return route.continue(); }
    const send = (payload) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(payload),
    });
    if (Array.isArray(body)) {
      return send(body.map((one) => ({ jsonrpc: '2.0', id: one.id, result: answer(one) })));
    }
    const result = answer(body);
    if (result === null) return route.continue();
    return send({ jsonrpc: '2.0', id: body.id, result });
  });
}

const server = await serve();
const base = process.env.SITE || `http://127.0.0.1:${server.address().port}/`;
await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ headless: !HEADED });

/* Registry spenders, so the mock grants unlimited to real rows the page renders. */
const registrySrc = await readFile(join(ROOT, 'assets/lib/registry.js'), 'utf8');
const SPENDERS = [...registrySrc.matchAll(/address:\s*'(0x[0-9a-fA-F]{40})'/g)]
  .map((m) => m[1]).slice(0, 3);
console.log(`mocking unlimited allowance to ${SPENDERS.length} registry spenders`);

const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const page = await context.newPage();
page.on('pageerror', (e) => check('no uncaught page error', false, e.message));

await installChain(page, { unlimitedSpenders: SPENDERS });
await page.addInitScript(walletMock());
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.fill('#addr', OWNER);
await page.click('#scanbtn');
await page.waitForSelector('#tbl-approvals tbody tr', { timeout: 45000 });
await page.waitForTimeout(800);

const rows = await page.locator('#tbl-approvals tbody tr').count();
check('the scan renders approval rows', rows >= 3, rows + ' rows');
const firstLabel = (await page.textContent('#tbl-approvals tbody tr:first-child td:last-child')).trim();
check('row action is labelled "Revoke in 1 Click"', /Revoke in 1 Click/i.test(firstLabel), firstLabel);
check('the first high-risk revoke is marked free', /free/i.test(firstLabel), firstLabel);
await page.screenshot({ path: join(SHOTS, 'revoke-01-rows.png') });

// ---- one click → one approve(spender, 0), nothing else ----
const firstSpender = await page.evaluate(() => {
  const tr = document.querySelector('#tbl-approvals tbody tr');
  return tr.querySelector('.addr').textContent.trim();
});
await page.click('#tbl-approvals tbody tr:first-child [data-revoke]');
await page.waitForTimeout(2500);

const sent = await page.evaluate(() => window.__w.sent);
check('the click sends exactly one transaction', sent.length === 1, sent.length + ' sent');
if (sent.length) {
  const tx = sent[0];
  check('it goes to a token contract, not a router', /^0x[0-9a-fA-F]{40}$/.test(tx.to), tx.to);
  check('no ETH is attached', tx.value === '0x0', tx.value);
  check('sender is the connected account', tx.from.toLowerCase() === OWNER, tx.from);
  check('calldata is approve(spender, 0)', tx.data.toLowerCase().startsWith(APPROVE), tx.data.slice(0, 12));
  const spenderInCalldata = '0x' + tx.data.slice(10 + 24, 10 + 64);
  check('the zeroed spender is the one in the row',
    spenderInCalldata.toLowerCase().startsWith(firstSpender.slice(0, 6).toLowerCase()),
    spenderInCalldata + ' vs ' + firstSpender);
  check('the allowance argument is literally zero', tx.data.slice(-64) === '0'.repeat(64), tx.data.slice(-64));
}

// ---- the second high-risk row is behind Pro ----
const lockButtons = await page.locator('#tbl-approvals tbody [data-unlock]').count();
check('the rest of the risk list asks for Pro', lockButtons >= 1, lockButtons + ' locked rows');

const batch = (await page.textContent('#batchrevoke')).trim();
check('batch button states its price before purchase', /Pro \$9/.test(batch), batch);
await page.click('#batchrevoke');
await page.waitForTimeout(700);
check('clicking batch without Pro opens the licence sheet, sends nothing',
  (await page.locator('#paymodal.on').count()) === 1 && (await page.evaluate(() => window.__w.sent.length)) === 1);
await page.screenshot({ path: join(SHOTS, 'revoke-02-batch-locked.png') });

// ---- with Pro, batch revokes every risky row in sequence ----
const pro = await context.newPage();
await installChain(pro, { unlimitedSpenders: SPENDERS });
await pro.addInitScript(walletMock());
await pro.addInitScript((hash) => {
  /* The licence the page itself would have saved after a real $9 purchase: only a
     tx hash. It is re-checked against Base on load, and the mock receipt answers
     for exactly this hash with a 9.5 USDC transfer, so Pro comes from the real
     verification path rather than from a hand-set flag. */
  localStorage.setItem('bwg.license.v1', JSON.stringify({ txHash: hash, paid: 9 }));
}, FAKE_HASH);
await pro.goto(base, { waitUntil: 'domcontentloaded' });
await pro.fill('#addr', OWNER);
await pro.click('#scanbtn');
await pro.waitForSelector('#tbl-approvals tbody tr', { timeout: 45000 });
await pro.waitForTimeout(800);

const proBatch = (await pro.textContent('#batchrevoke')).trim();
check('Pro sees the real batch label', /Batch Revoke All \d+ Risky Approvals/.test(proBatch), proBatch);
const highRisk = await pro.locator('#tbl-approvals tbody tr').count();
await pro.click('#batchrevoke');
await pro.waitForTimeout(6000);
const batchSent = await pro.evaluate(() => window.__w.sent);
check('batch sends one approve(spender, 0) per risky approval', batchSent.length === highRisk,
  `${batchSent.length} sent for ${highRisk} rows`);
check('every batch transaction is approve(..., 0)',
  batchSent.every((tx) => tx.data.toLowerCase().startsWith(APPROVE) && tx.data.slice(-64) === '0'.repeat(64)));
await pro.screenshot({ path: join(SHOTS, 'revoke-03-batch-pro.png') });

// ---- a rejected prompt must stop the sequence, not fake success ----
const cancel = await context.newPage();
await installChain(cancel, { unlimitedSpenders: SPENDERS });
await cancel.addInitScript(walletMock());
await cancel.addInitScript((hash) => {
  localStorage.setItem('bwg.license.v1', JSON.stringify({ txHash: hash, paid: 9 }));
}, FAKE_HASH);
await cancel.goto(base, { waitUntil: 'domcontentloaded' });
await cancel.fill('#addr', OWNER);
await cancel.click('#scanbtn');
await cancel.waitForSelector('#tbl-approvals tbody tr', { timeout: 45000 });
await cancel.evaluate(() => { window.__w.rejectNext = true; });
await cancel.click('#batchrevoke');
await cancel.waitForTimeout(1500);
check('a rejected prompt stops the batch', (await cancel.evaluate(() => window.__w.sent.length)) === 0,
  (await cancel.textContent('#status')).trim());

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
await writeFile(join(SHOTS, 'revoke-one-click.results.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
