// Wallet connection, the $9 USDC purchase, and on-chain licence verification.
// There is no server. A licence is a Base transaction that this module can re-verify at any time
// from any device, which is also why the receipt is the only thing stored.

import { CHAIN, PAY_TO, PRO_PRICE_UNITS, PRO_PRICE_USDC } from './registry.js';
import { encBalanceOf, encTransfer, getReceipt, rpc } from './rpc.js';

const LICENSE_KEY = 'bwg.license.v1';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export function hasProvider() {
  return typeof window !== 'undefined' && !!window.ethereum;
}

export async function connect() {
  if (!hasProvider()) throw new Error('No browser wallet detected. Install MetaMask, Rabby or Coinbase Wallet.');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts.length) throw new Error('No account authorised.');
  return accounts[0];
}

export async function currentChainId() {
  if (!hasProvider()) return null;
  const id = await window.ethereum.request({ method: 'eth_chainId' });
  return Number(BigInt(id));
}

export async function ensureBase() {
  const id = await currentChainId();
  if (id === CHAIN.id) return true;
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN.idHex }],
    });
    return true;
  } catch (e) {
    if (e && (e.code === 4902 || /unrecognized/i.test(e.message || ''))) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN.idHex,
          chainName: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: [CHAIN.explorer],
        }],
      });
      return true;
    }
    throw e;
  }
}

/** Send the $9 USDC payment. Returns the transaction hash. */
export async function payPro(from) {
  await ensureBase();
  const data = encTransfer(PAY_TO, PRO_PRICE_UNITS);
  const hash = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
      from,
      to: CHAIN.usdc,
      data,
      value: '0x0',
    }],
  });
  return hash;
}

/**
 * What the connected wallet actually has on Base, read from the chain before asking
 * anyone to sign. A buyer who holds $3 of USDC should be told that here, not by their
 * wallet after a failed send. Nulls mean "could not read", not "zero".
 */
export async function preflight(from) {
  const [usdcHex, ethHex] = await Promise.all([
    rpc('eth_call', [{ to: CHAIN.usdc, data: encBalanceOf(from) }, 'latest']).catch(() => null),
    rpc('eth_getBalance', [from, 'latest']).catch(() => null),
  ]);
  let usdc = null;
  let eth = null;
  try {
    if (usdcHex) usdc = BigInt(usdcHex);
  } catch {
    /* unreadable */
  }
  try {
    if (ethHex) eth = BigInt(ethHex);
  } catch {
    /* unreadable */
  }
  return { usdc, eth };
}

/** A sentence a buyer can act on, or null when the wallet can pay. */
export function shortfall({ usdc }) {
  if (usdc === null || usdc >= PRO_PRICE_UNITS) return null;
  return `This wallet holds ${(Number(usdc) / 1e6).toFixed(2)} USDC on Base. The licence costs ${PRO_PRICE_USDC}.00 — top up, then pay again.`;
}

/**
 * Verify a Base transaction really paid at least 9 USDC to the project address.
 * Reads the receipt and decodes the ERC-20 Transfer log. Nothing is trusted from the client.
 */
export async function verifyPayment(txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) {
    return { ok: false, reason: 'That is not a 32-byte transaction hash.' };
  }

  const receipt = await getReceipt(txHash);
  if (!receipt) return { ok: false, reason: 'Transaction not found on Base. It may still be pending — try again in a few seconds.' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'That transaction reverted, so no payment was made.' };

  const wantTo = PAY_TO.toLowerCase();
  let paid = 0n;

  for (const log of receipt.logs || []) {
    if ((log.address || '').toLowerCase() !== CHAIN.usdc.toLowerCase()) continue;
    const topics = log.topics || [];
    if (!topics.length || topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topics.length < 3) continue;
    const to = '0x' + topics[2].slice(-40).toLowerCase();
    if (to !== wantTo) continue;
    try {
      paid += BigInt(log.data);
    } catch {
      /* ignore malformed */
    }
  }

  if (paid < PRO_PRICE_UNITS) {
    return {
      ok: false,
      reason: `That transaction paid ${Number(paid) / 1e6} USDC to this address, which is below the ${PRO_PRICE_USDC} USDC price.`,
    };
  }

  return {
    ok: true,
    paid: Number(paid) / 1e6,
    block: Number(BigInt(receipt.blockNumber)),
    from: receipt.from,
    txHash,
  };
}

// ---------- licence storage ----------

export function saveLicense(info) {
  try {
    localStorage.setItem(LICENSE_KEY, JSON.stringify({ ...info, savedAt: new Date().toISOString() }));
  } catch {
    /* storage may be blocked; the session still works */
  }
}

export function loadLicense() {
  try {
    const raw = localStorage.getItem(LICENSE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearLicense() {
  try {
    localStorage.removeItem(LICENSE_KEY);
  } catch {
    /* noop */
  }
}

/** Re-check a stored licence against the chain, so a shared localStorage value is not enough. */
export async function revalidate(license) {
  if (!license || !license.txHash) return false;
  try {
    const v = await verifyPayment(license.txHash);
    return v.ok;
  } catch {
    // offline: keep the stored licence rather than locking a paying user out
    return true;
  }
}

export { rpc };
