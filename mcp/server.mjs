#!/usr/bin/env node
// A local MCP server for the same approval engine the web page runs.
//
// It speaks MCP over stdio, exposes two read-only tools, and touches nothing but the
// public Base RPC endpoints. There is no account, no key, and no upload: the wallet
// address you pass in is the only thing that leaves this process.
//
//   node mcp/server.mjs
//
// Register it with any MCP client:
//   { "mcpServers": { "base-wallet-guard": { "command": "node",
//       "args": ["/absolute/path/to/base-tax-audit/mcp/server.mjs"] } } }
//
// Manifest: mcp.json and .well-known/mcp.json in this repository.

import { createInterface } from 'node:readline';
import { coreTokenSet, readCoreBalances, runMatrix, withBalances } from '../assets/lib/approvals.js';
import { SPENDERS, CHAIN, PAY_TO, PRO_PRICE_USDC } from '../assets/lib/registry.js';
import { encAllowance, rpc } from '../assets/lib/rpc.js';

const PROTOCOL = '2024-11-05';
const SERVER = { name: 'base-wallet-guard', version: '1.0.0' };

const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

const TOOLS = [
  {
    name: 'scan_approvals',
    description:
      'Read every ERC-20 allowance a Base wallet has granted to a verified registry of routers, ' +
      'aggregators, lending markets and marketplaces, plus the wallet balances behind them, and ' +
      'return the approvals that are still live. Pure eth_call reads against Base mainnet; no ' +
      'account, no API key, nothing uploaded. An approval revoked on-chain reads zero and is dropped.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Base wallet address, 0x-prefixed, 40 hex characters.' },
        onlyUnlimited: {
          type: 'boolean',
          description: 'Return only approvals whose allowance is effectively unlimited. Default false.',
        },
      },
      required: ['address'],
      additionalProperties: false,
    },
    // Machine-readable form of the promise in the description: this tool reads
    // public chain state and never signs, sends or writes anything.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'check_allowance',
    description:
      'Read a single ERC-20 allowance(owner, spender) on Base. Useful when the spender is not in the ' +
      'built-in registry: ask the contract the question directly instead of trusting a list.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Token holder address on Base.' },
        token: { type: 'string', description: 'ERC-20 contract address on Base.' },
        spender: { type: 'string', description: 'Address allowed to move the tokens.' },
      },
      required: ['owner', 'token', 'spender'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'pricing',
    description: 'What the Pro licence costs, where the payment goes, and how it is verified.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const big = (v) => (typeof v === 'bigint' ? v.toString() : v);
const jsonSafe = (v) =>
  JSON.parse(
    JSON.stringify(v, (k, val) => {
      if (typeof val === 'bigint') return val.toString();
      return val;
    })
  );

async function scanApprovals({ address, onlyUnlimited = false }) {
  if (!isAddress(address)) throw new Error('address must be a 0x-prefixed 40-hex Base address');

  const started = Date.now();
  const { ethBalance, tokens } = await readCoreBalances(address);
  const index = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
  const { rows, checks } = await runMatrix(address, tokens, SPENDERS);
  const withBal = withBalances(rows, index);

  const live = withBal
    .filter((r) => (onlyUnlimited ? r.tier === 'unlimited' : true))
    .map((r) => ({
      token: r.token,
      tokenAddress: r.tokenAddress,
      spender: r.spender,
      spenderAddress: r.spenderAddress,
      spenderKind: r.spenderKind,
      allowance: big(r.allowance),
      tier: r.tier,
      balance: big(r.balance ?? 0n),
    }));

  return {
    address,
    chain: { id: CHAIN.id, name: CHAIN.name },
    ethBalanceWei: ethBalance,
    allowanceReads: checks,
    elapsedMs: Date.now() - started,
    liveApprovals: live,
    unlimitedCount: live.filter((r) => r.tier === 'unlimited').length,
    limits:
      'A complete approval history needs an archive-node log sweep, which no free public Base RPC ' +
      'allows. This reads current allowances instead, so an approval to a contract this wallet never ' +
      'touched and that is not in the registry will not appear.',
  };
}

async function checkAllowance({ owner, token, spender }) {
  for (const [name, v] of Object.entries({ owner, token, spender })) {
    if (!isAddress(v)) throw new Error(`${name} must be a 0x-prefixed 40-hex address`);
  }
  const raw = await rpc('eth_call', [{ to: token, data: encAllowance(owner, spender) }, 'latest']);
  const allowance = raw && raw !== '0x' ? BigInt(raw) : 0n;
  return {
    owner,
    token,
    spender,
    allowance: allowance.toString(),
    unlimited: allowance >= 2n ** 255n,
    revoked: allowance === 0n,
  };
}

function pricing() {
  return {
    product: 'Base Wallet Guard & Tax CSV Studio — Pro licence',
    priceUsdc: PRO_PRICE_USDC,
    asset: CHAIN.usdc,
    network: { name: CHAIN.name, chainId: CHAIN.id },
    payTo: PAY_TO,
    verification:
      'Client-side: the page reads the transaction receipt and requires a USDC Transfer of at least ' +
      `${PRO_PRICE_USDC}.000000 to payTo. The receipt is the licence, so it works from any device.`,
    purchaseUrl: 'https://9xj89gzrtw-hue.github.io/base-tax-audit/#pricing',
    manifest: 'https://9xj89gzrtw-hue.github.io/base-tax-audit/.well-known/x402',
  };
}

async function callTool(name, args) {
  switch (name) {
    case 'scan_approvals':
      return scanApprovals(args || {});
    case 'check_allowance':
      return checkAllowance(args || {});
    case 'pricing':
      return pricing();
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let pending = 0;
let closing = false;

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  pending++;
  try {
    await handleLine(text);
  } finally {
    pending--;
    if (closing && pending === 0) process.exit(0);
  }
});

async function handleLine(text) {
  let req;
  try {
    req = JSON.parse(text);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (req.id === undefined) return; // notification (e.g. notifications/initialized)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id: req.id, error: { code, message } });

  try {
    switch (req.method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args } = req.params || {};
        try {
          const out = jsonSafe(await callTool(name, args));
          return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${req.method}`);
    }
  } catch (e) {
    return fail(-32603, String(e.message || e));
  }
}

rl.on('close', () => {
  closing = true;
  if (pending === 0) process.exit(0);
});
