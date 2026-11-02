// Verified on-chain on Base mainnet (chain 177 not used here; chain 8453).
// Every address below was checked with eth_getCode on 2026-11-01 and had non-empty bytecode.
// Two candidates failed that check and were removed (Across SpokePool, EURC) rather than shipped.

export const CHAIN = {
  id: 8453,
  idHex: '0x2105',
  name: 'Base',
  explorer: 'https://base.blockscout.com',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  usdcDecimals: 6,
  weth: '0x4200000000000000000000000000000000000006',
};

export const PAY_TO = '0x72Aa6edDE71B94f6b99c8e52EdC02B5C75F74d1a';
export const PRO_PRICE_USDC = 9;
export const PRO_PRICE_UNITS = 9_000_000n;

// Spenders that can move a holder's tokens. Grouped by what a bad approval would cost.
export const SPENDERS = [
  { name: 'Uniswap Permit2', address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', kind: 'Router', note: 'Master allowance contract for Uniswap v3/v4 and many other Base apps. An unlimited approval here is reusable by any app that routes through Permit2.' },
  { name: 'Uniswap Universal Router', address: '0x6fF5693b99212Da76ad316178A184AB56D299b43', kind: 'Router', note: 'Swap and liquidity entry point for Uniswap on Base.' },
  { name: 'Uniswap SwapRouter02', address: '0x2626664c2603336E57B271c5C0b26F421741e481', kind: 'Router', note: 'Uniswap v3 swap router.' },
  { name: 'Uniswap V3 PositionManager', address: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', kind: 'Liquidity', note: 'Mints and manages Uniswap v3 LP positions.' },
  { name: 'Uniswap V4 PositionManager', address: '0x7C5f5A4bBd8fD63184577525326123B519429bDc', kind: 'Liquidity', note: 'Mints and manages Uniswap v4 LP positions.' },
  { name: 'Uniswap V2 Router02', address: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', kind: 'Router', note: 'Uniswap v2 swaps and liquidity.' },
  { name: 'Aerodrome Router', address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', kind: 'Router', note: 'Largest native DEX on Base by volume.' },
  { name: '1inch v6 Router', address: '0x111111125421cA6dc452d289314280a0f8842A65', kind: 'Aggregator', note: 'Aggregates liquidity across Base DEXes.' },
  { name: '0x AllowanceHolder', address: '0x0000000000001fF3684f28c67538d4D072C22734', kind: 'Aggregator', note: '0x Settler pulls tokens through this holder.' },
  { name: 'Odos Router V2', address: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1', kind: 'Aggregator', note: 'Multi-path swap router.' },
  { name: 'KyberSwap Router', address: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', kind: 'Aggregator', note: 'Kyber meta-aggregation router.' },
  { name: 'ParaSwap V6', address: '0x6A000F20005980200259B80c5102003040001068', kind: 'Aggregator', note: 'ParaSwap Augustus v6.' },
  { name: 'SushiSwap Router', address: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891', kind: 'Router', note: 'SushiSwap on Base.' },
  { name: 'BaseSwap Router', address: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', kind: 'Router', note: 'BaseSwap DEX router.' },
  { name: 'Aave V3 Pool', address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', kind: 'Lending', note: 'Supply and borrow market. Approvals are normally capped to the supplied amount.' },
  { name: 'Morpho Blue', address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', kind: 'Lending', note: 'Permissionless lending markets.' },
  { name: 'Compound III USDC', address: '0xb125E6687d4313864e53df431d5425969c15Eb2F', kind: 'Lending', note: 'Comet USDC market on Base.' },
  { name: 'Moonwell Comptroller', address: '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C', kind: 'Lending', note: 'Moonwell risk engine on Base.' },
  { name: 'Seaport 1.6', address: '0x0000000000000068F116a894984e2DB1123eB395', kind: 'Marketplace', note: 'OpenSea order fulfilment.' },
  { name: 'Seaport 1.5', address: '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC', kind: 'Marketplace', note: 'OpenSea order fulfilment (legacy).' },
  { name: 'OpenSea Conduit', address: '0x00000000F9490004C11Cef243f5400493c00Ad63', kind: 'Marketplace', note: 'OpenSea transfer conduit.' },
  { name: 'LI.FI Diamond', address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', kind: 'Bridge', note: 'Cross-chain bridge aggregator.' },
  { name: 'Stargate Router', address: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B', kind: 'Bridge', note: 'LayerZero Stargate bridge.' },
];

// Blue-chip tokens always checked, even at zero balance: an approval survives a zero balance,
// so a wallet can be re-drained the moment it is funded again.
export const CORE_TOKENS = [
  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, core: true },
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, core: true },
  { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', symbol: 'USDT', decimals: 6, core: true },
  { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18, core: true },
  { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', decimals: 8, core: true },
  { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', decimals: 18, core: true },
  { address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', symbol: 'wstETH', decimals: 18, core: true },
  { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', decimals: 18, core: true },
  { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT', decimals: 18, core: true },
  { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN', decimals: 18, core: true },
  { address: '0xAc1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', symbol: 'TOSHI', decimals: 18, core: true },
];

export const EXPLORER_TX = (h) => `${CHAIN.explorer}/tx/${h}`;
export const EXPLORER_ADDR = (a) => `${CHAIN.explorer}/address/${a}`;
