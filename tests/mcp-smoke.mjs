// Prove the stdio MCP server actually speaks the protocol, not just that the file
// exists: spawn it the way a client does, initialize, list tools, call the two
// tools that need no network, and check the shapes a client would rely on.
//
// `scan_approvals` and `check_allowance` are exercised only for their input
// validation here — a passing run never needs an RPC endpoint, so this test is
// safe in CI and offline.
//
//   node tests/mcp-smoke.mjs
//
// Exit code 0 means every assertion passed.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SERVER = join(ROOT, 'mcp', 'server.mjs');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
const rl = createInterface({ input: child.stdout });
const waiters = new Map();
let nextId = 1;

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const waiter = waiters.get(msg.id);
  if (waiter) { waiters.delete(msg.id); waiter(msg); }
});

let stderr = '';
child.stderr.on('data', (b) => { stderr += String(b); });

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30000);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const toolText = (msg) => {
  const content = (msg.result && msg.result.content) || [];
  const first = content[0] || {};
  return { text: String(first.text || ''), isError: !!(msg.result && msg.result.isError) };
};

try {
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
  });
  check('initialize returns the 2024-11-05 protocol',
    init.result && init.result.protocolVersion === '2024-11-05',
    init.result && init.result.protocolVersion);
  check('server identifies itself', /^base-wallet-guard$/.test((init.result.serverInfo || {}).name || ''),
    (init.result.serverInfo || {}).name);

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await call('tools/list', {});
  const tools = (list.result && list.result.tools) || [];
  const names = tools.map((t) => t.name);
  check('the three documented tools are listed',
    ['scan_approvals', 'check_allowance', 'pricing'].every((n) => names.includes(n)), names.join(', '));
  check('every tool carries a JSON schema',
    tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  check('every tool declares readOnlyHint, so a client can gate it without reading prose',
    tools.every((t) => t.annotations && t.annotations.readOnlyHint === true),
    tools.map((t) => `${t.name}:${t.annotations && t.annotations.readOnlyHint}`).join(' '));
  check('no tool claims to be destructive',
    tools.every((t) => !t.annotations || t.annotations.destructiveHint !== true));

  const price = await call('tools/call', { name: 'pricing', arguments: {} });
  const { text: priceText, isError: priceErr } = toolText(price);
  check('pricing answers without an RPC endpoint', !priceErr, priceText.slice(0, 60).replace(/\s+/g, ' '));
  let priceJson = null;
  try { priceJson = JSON.parse(priceText); } catch { /* handled next */ }
  check('pricing states the $9 USDC price on Base',
    priceJson && priceJson.priceUsdc === 9 && priceJson.network && priceJson.network.chainId === 8453,
    priceJson ? `${priceJson.priceUsdc} USDC on ${priceJson.network.name}` : 'unparsable');
  check('pricing names the treasury the licence is checked against',
    priceJson && /^0x[0-9a-fA-F]{40}$/.test(priceJson.payTo || ''), priceJson && priceJson.payTo);

  const bad = await call('tools/call', { name: 'scan_approvals', arguments: { address: 'not-an-address' } });
  const { text: badText, isError: badErr } = toolText(bad);
  check('a malformed address is rejected with a readable message',
    badErr && /address/i.test(badText), badText.slice(0, 80));

  const unknown = await call('tools/call', { name: 'no_such_tool', arguments: {} });
  check('an unknown tool fails instead of returning empty data',
    !!(unknown.result && unknown.result.isError), String((unknown.result || {}).isError));

  const bogus = await call('does/not/exist', {});
  check('an unknown method returns JSON-RPC -32601',
    !!(bogus.error && bogus.error.code === -32601), JSON.stringify(bogus.error || {}).slice(0, 80));
} finally {
  child.stdin.end();
  child.kill();
}

const failed = results.filter((r) => !r.ok);
if (failed.length && stderr.trim()) console.log('\nserver stderr:\n' + stderr.trim().slice(0, 800));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
