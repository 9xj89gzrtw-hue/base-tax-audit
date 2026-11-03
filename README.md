# Base Wallet Guard & Tax CSV Studio

Scan any Base wallet for live token approvals and export its history as a tax-ready CSV or XLSX.
No account, no API key, no server, no upload. Everything runs in the browser.

Live: **https://9xj89gzrtw-hue.github.io/base-tax-audit/**

---

## What it does

**Free, no wallet connection required**

- Paste any `0x` address and get live balances, recent activity and current ERC-20 allowances.
- Flags **unlimited** approvals and prices what a spender could move right now.
- Exports the first 50 ledger rows as CSV.
- Revokes one approval from the browser wallet.

**Pro — 9 USDC on Base, once**

- Up to 10,000 transactions across 2025–2026, paginated in full.
- FIFO cost basis with realised gains and open lots.
- Koinly CSV, CoinTracker CSV, a flat ledger CSV, and a four-sheet XLSX.
- Batch revoke every high-risk approval in one sequence.

The licence is a Base transaction, verified by reading its receipt in the browser. Nothing is
stored server-side because there is no server.

---

## How the approval check works

A complete approval history requires an archive-node `eth_getLogs` sweep over the wallet's whole
lifetime. Every free public Base RPC caps that range — between 10 and 50,000 blocks per request,
against ~43,200 blocks produced per day. A browser-side full-history sweep is not possible on
free infrastructure.

So the page asks the chain a better question: **what is the allowance right now?**

```
allowance(owner, spender) -> uint256
```

It reads that for every token the wallet holds against a registry of 23 verified Base spenders
(routers, aggregators, lending markets, marketplaces, bridges — each checked with `eth_getCode`),
plus contracts discovered from the wallet's own history. A revoked approval reads zero and is
dropped. The one case that escapes is an approval granted to a contract the wallet never
transacted with directly; the UI says so rather than claiming completeness.

See [`ENGINEERING_NOTES.md`](../ENGINEERING_NOTES.md) for the full rationale and measurements.

---

## Performance

| Milestone | Time |
|---|---|
| Balance + unlimited approvals | **300 – 1200 ms** |
| Full token coverage | 2.7 – 12 s |
| Tax ledger | 8 – 18 s |
| Cached re-scan | **432 ms** |

The risk answer comes from chain reads alone and never waits for the indexer. The tail is
Blockscout's own latency (`token-balances` measured between 2.4 s and 14.4 s under load); it is
made legible with a per-step status line rather than hidden behind a spinner.

---

## Failure behaviour

A security tool that reports "no approvals" when the indexer failed is worse than no tool.
Each data source reports its own success, and a partial scan is labelled as partial:

- token list unavailable → *"Scan limited"*, approvals panel turns amber, states that only
  blue-chip tokens were checked;
- token transfers unavailable → the tax panel states that any gain figure is **wrong, not merely
  incomplete**.

All four failure paths are tested by intercepting the request and returning HTTP 429.

---

## Layout

```
index.html              page shell, copy, pricing
assets/style.css        light interface
assets/app.js           UI controller
assets/lib/rpc.js       RPC pool, parallel batching, ABI helpers
assets/lib/blockscout.js indexer client with caching
assets/lib/approvals.js allowance matrix engine
assets/lib/registry.js  verified spenders and tokens
assets/lib/tax.js       ledger, FIFO, CSV formatters
assets/lib/xlsx.js      dependency-free XLSX writer
assets/lib/pay.js       wallet connect, payment, receipt verification
mcp/server.mjs          stdio MCP server over the same engine
.well-known/x402        x402 discovery record (9 USDC, Base)
.well-known/mcp.json    MCP server manifest
tests/one-click-pay.mjs 18-assertion browser test of the purchase
```

No build step, no dependencies, no bundler. Open `index.html` from any static host.

---

## One-click purchase, and what it refuses to do

The Pro button is the whole funnel: with a wallet present, one click asks the wallet for one
USDC `transfer` and the receipt unlocks the export. There is no form, no sign-up, no email.

Before the buyer signs, the page reads their Base balances and says what it finds:

- below 9.00 USDC → the exact shortfall, and no signature is requested at all;
- 0 ETH for gas → a warning, because a USDC transfer still needs a few cents of ETH;
- no wallet extension → the sheet switches to a manual path (send from an exchange, paste the
  hash) instead of a dead button.

`node tests/one-click-pay.mjs` proves this end to end in Chromium: 18 assertions covering the
calldata, the receipt decode, the stored licence, a rejected signature, an underfunded wallet
and the no-wallet fallback. `window.ethereum` and four chain reads are mocked; everything else
is the real page paying attention to the real chain.

---

## Machine-readable surfaces

| Path | What it is |
|---|---|
| `/.well-known/x402` | x402 v2 discovery record: 9.00 USDC, Base `eip155:8453`, `payTo`, and how delivery is verified (receipt, not a session). |
| `/.well-known/mcp.json`, `mcp.json` | MCP server manifest for the local scanner. |
| `mcp/server.mjs` | A working stdio MCP server (`scan_approvals`, `check_allowance`, `pricing`) that imports the same engine the page uses. No credentials, read-only, public RPC. |

```json
{ "mcpServers": { "base-wallet-guard": {
    "command": "node", "args": ["/abs/path/base-tax-audit/mcp/server.mjs"] } } }
```

Measured on `0xB2Da8A3a86ee0b3C5334B9bC02E5A76FF0419020` on 2026-11-03: 253 allowance reads in
**2.9 s**, one live unlimited USDC→Permit2 approval with 841.83 USDC behind it.

---

## Running locally

```sh
python3 -m http.server 8777
# then open http://127.0.0.1:8777/
```

A local server is required because the page uses ES modules; `file://` will not load them.

---

## Verified against real wallets

`0xB2Da8A3a86ee0b3C5334B9bC02E5A76FF0419020` — 14 tokens × 23 spenders = 322 allowance reads,
2 unlimited approvals to Uniswap Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`),
$1,272.78 exposed at the time of the scan. Confirmed independently with raw `eth_call` before
the UI was trusted.
