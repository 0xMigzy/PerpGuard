# Token icons: sources and licences

Vendored, not fetched at runtime. Each file was taken from a permissively
licensed set at a pinned version, and its identity was checked against that
set's own metadata (name, symbol and website), never inferred from a ticker
alone. Nothing here was taken from an exchange site or a token project's page.

| File | Asset | Source | Licence |
|---|---|---|---|
| btc.svg | Bitcoin | Cryptocurrency Icons 0.18.1, `svg/color/btc.svg` | CC0 1.0 |
| eth.svg | Ethereum | Cryptocurrency Icons 0.18.1, `svg/color/eth.svg` | CC0 1.0 |
| sol.svg | Solana | Cryptocurrency Icons 0.18.1, `svg/color/sol.svg` | CC0 1.0 |
| zec.svg | Zcash | Cryptocurrency Icons 0.18.1, `svg/color/zec.svg` | CC0 1.0 |
| uni.svg | Uniswap | Cryptocurrency Icons 0.18.1, `svg/color/uni.svg` | CC0 1.0 |
| aave.svg | Aave | Cryptocurrency Icons 0.18.1, `svg/color/aave.svg` | CC0 1.0 |
| mon.png | Monad (monad.xyz) | Trust Wallet assets, `blockchains/monad/info/logo.png` | MIT |
| hype.png | Hyperliquid (hyperliquid.xyz) | Trust Wallet assets, `blockchains/hyperevm/info/logo.png` | MIT |
| near.png | NEAR Protocol | Trust Wallet assets, `blockchains/near/info/logo.png` | MIT |
| arb.png | Arbitrum | Trust Wallet assets, `blockchains/ethereum/assets/0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1/logo.png` | MIT |
| ena.png | Ethena (ethena.fi) | Trust Wallet assets, `blockchains/ethereum/assets/0x57e114B691Db790C35207b2e685D4A43181e6061/logo.png` | MIT |
| morpho.png | Morpho | Trust Wallet assets, `blockchains/ethereum/assets/0x58D97B57BB95320F9a05dC918Aef65434969c2B2/logo.png` | MIT |
| pump.png | pump.fun (pump.fun) | Trust Wallet assets, `blockchains/solana/assets/pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn/logo.png` | MIT |
| vvv.png | Venice (venice.ai) | Trust Wallet assets, `blockchains/base/assets/0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf/logo.png` | MIT |

- **Cryptocurrency Icons** (https://github.com/spothq/cryptocurrency-icons),
  npm package `cryptocurrency-icons@0.18.1`. Public domain dedication:
  `LICENSE-cryptocurrency-icons-CC0.md`.
- **Trust Wallet assets** (https://github.com/trustwallet/assets) at commit
  `bbe582d25a22a0367c25a5e7097ad3e0f75e2287`. The repository ships PNGs, not SVGs, so these are PNG. Copyright
  notice and terms: `LICENSE-trustwallet-assets-MIT.txt`.

**On the fallback** (a neutral circle with the market's initials, drawn in
`apps/web/src/components/TokenIcon.tsx`):

- **LIT**: the ticker names more than one token (Litentry, and the later
  Lighter), and the venue's context gives no more than the ticker, so no logo
  can be attributed to it with certainty.
- **TAO**: neither set has Bittensor's own entry; a wrapped-token logo would be
  a different asset.

A market added later is on the fallback until a file for it is added here, with
its row in this table.
