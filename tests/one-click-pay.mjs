// End-to-end proof that the $9 Pro purchase works in a real browser with a wallet.
//
// What is real here: the page, its modules, the DOM, the click path, the calldata, the
// ERC-20 receipt decoding and the licence storage.
// What is mocked: window.ethereum (a stand-in for MetaMask/Rabby) and four chain reads —
// the receipt for the hash the mock wallet returned, the buyer's USDC balance, the
// buyer's ETH balance, and eth_chainId. Everything else still goes to Base mainnet.
//
//   node tests/one-click-pay.mjs            # headless run + screenshots
//   node tests/one-click-pay.mjs --headed   # watch it
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

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PAY_TO = '0x72aa6edde71b94f6b99c8e52edc02b5c75f74d1a';
const BUYER = '0x1111111111111111111111111111111111111111';
const FAKE_HASH = '0x' + 'ab'.repeat(32);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
      if (!file.startsWith(ROOT) || !existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A wallet that behaves the way MetaMask does for this flow.
function walletMock() {
  return `
    window.__wallet = { calls: [], sent: null, chainId: '0x2105', rejectNext: false };
    window.ethereum = {
      isMetaMask: true,
      request: async (args) => {
        window.__wallet.calls.push(args);
        const m = args.method;
        if (m === 'eth_requestAccounts' || m === 'eth_accounts') return ['${BUYER}'];
        if (m === 'eth_chainId') return window.__wallet.chainId;
        if (m === 'wallet_switchEthereumChain') { window.__wallet.chainId = args.params[0].chainId; return null; }
        if (m === 'eth_sendTransaction') {
          if (window.__wallet.rejectNext) { window.__wallet.rejectNext = false; const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
          window.__wallet.sent = args.params[0];
          return '${FAKE_HASH}';
        }
        return null;
      },
    };
  `;
}

const pad64 = (h) => h.padStart(64, '0');
const receipt = {
  status: '0x1',
  blockNumber: '0x3a8f00',
  from: BUYER,
  to: USDC,
  logs: [
    {
      address: USDC,
      topics: [TRANSFER_TOPIC, '0x' + pad64(BUYER.slice(2)).replace(/^0+/, '0'.repeat(24)), '0x' + pad64(PAY_TO.slice(2)).replace(/^0+/, '0'.repeat(24))],
      data: '0x' + pad64((9_000_000).toString(16)),
    },
  ],
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

/** Answer the handful of chain reads the payment path makes; let everything else through. */
async function installChainStubs(page, { usdc = 50_000_000n, eth = 2_000_000_000_000_000n } = {}) {
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    let body;
    try {
      body = JSON.parse(req.postData() || '{}');
    } catch {
      return route.continue();
    }
    if (Array.isArray(body)) return route.continue();

    const one = (result) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    });

    if (body.method === 'eth_getTransactionReceipt' && (body.params || [])[0] === FAKE_HASH) return one(receipt);
    if (body.method === 'eth_chainId') return one('0x2105');
    if (body.method === 'eth_getBalance' && (body.params || [])[0].toLowerCase() === BUYER) {
      return one('0x' + eth.toString(16));
    }
    if (body.method === 'eth_call') {
      const call = (body.params || [])[0] || {};
      const owner = (call.data || '').slice(-40).toLowerCase();
      if (call.to && call.to.toLowerCase() === USDC && owner === BUYER.slice(2) && (call.data || '').startsWith('0x70a08231')) {
        return one('0x' + pad64(usdc.toString(16)));
      }
    }
    return route.continue();
  });
}

const server = await serve();
const base = process.env.SITE || `http://127.0.0.1:${server.address().port}/`;
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => check('no uncaught page error', false, e.message));

await installChainStubs(page);
await page.addInitScript(walletMock());
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);

const buyLabel = await page.textContent('#buybtn');
check('pricing shows the $9 button', /\$9/.test(buyLabel || ''), (buyLabel || '').trim());
await page.screenshot({ path: join(SHOTS, '01-pricing.png') });

// ---- 1-CLICK: the Pro button sends the transaction without an intermediate form ----
await page.click('#buybtn');
await page.waitForTimeout(2500);

const sent = await page.evaluate(() => window.__wallet.sent);
check('one click from pricing asks the wallet to send', !!sent, sent ? JSON.stringify(sent).slice(0, 110) : 'nothing sent');
check('no payment form stood between the click and the signature', (await page.locator('#paymodal.on').count()) === 0);

if (sent) {
  check('transaction targets Base USDC', sent.to.toLowerCase() === USDC, sent.to);
  check('no ETH is attached', sent.value === '0x0', sent.value);
  check('sender is the connected account', sent.from.toLowerCase() === BUYER, sent.from);
  const want = '0xa9059cbb' + pad64(PAY_TO.slice(2)) + pad64((9_000_000).toString(16));
  check('calldata is transfer(payTo, 9.000000 USDC)', sent.data.toLowerCase() === want, sent.data);
}

const licence = await page.evaluate(() => {
  const raw = localStorage.getItem('bwg.license.v1');
  return raw ? JSON.parse(raw) : null;
});
check('licence stored after the receipt verifies', !!licence && licence.paid === 9, JSON.stringify(licence));

const stateLabel = await page.textContent('#licensestate');
check('header shows Pro unlocked', /Pro unlocked/i.test(stateLabel || ''), (stateLabel || '').trim());
check('user is told what was verified', /Unlocked/i.test((await page.textContent('#toast')) || ''));
check('the button stops selling once bought', await page.isDisabled('#buybtn'));
await page.screenshot({ path: join(SHOTS, '02-unlocked.png'), fullPage: false });

// ---- a rejected signature must not unlock anything ----
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(300);
await page.evaluate(() => { window.__wallet.rejectNext = true; });
await page.click('#buybtn');
await page.waitForTimeout(1200);
check('a rejected signature grants nothing', (await page.evaluate(() => localStorage.getItem('bwg.license.v1'))) === null);
check('a rejected signature is reported', /reject|cancel/i.test((await page.textContent('#toast')) || ''));
await page.screenshot({ path: join(SHOTS, '03-rejected.png') });

// ---- a wallet that cannot afford it is told so before signing ----
const poor = await context.newPage();
await installChainStubs(poor, { usdc: 3_200_000n });
await poor.addInitScript(walletMock());
await poor.goto(base, { waitUntil: 'domcontentloaded' });
await poor.waitForTimeout(400);
await poor.click('#buybtn');
await poor.waitForTimeout(1800);
check('an underfunded wallet is not asked to sign', (await poor.evaluate(() => window.__wallet.sent)) === null);
check('the shortfall names the balance and the price', /3\.20 USDC/.test((await poor.textContent('#toast')) || ''));
await poor.screenshot({ path: join(SHOTS, '04-underfunded.png') });

// ---- no provider: the sheet must still offer the manual path ----
const bare = await context.newPage();
await bare.addInitScript(() => { delete window.ethereum; });
await bare.goto(base, { waitUntil: 'domcontentloaded' });
await bare.waitForTimeout(400);
await bare.click('#buybtn');
await bare.waitForTimeout(600);
check('without a wallet the sheet opens', (await bare.locator('#paymodal.on').count()) === 1);
check('the tx-hash field is reachable', (await bare.locator('#txhash').count()) === 1);
check('an install hint is shown', /Rabby|MetaMask/.test((await bare.textContent('#nosupport')) || ''));
await bare.screenshot({ path: join(SHOTS, '05-no-wallet.png') });

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
await writeFile(
  join(SHOTS, 'one-click-pay.results.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2)
);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
