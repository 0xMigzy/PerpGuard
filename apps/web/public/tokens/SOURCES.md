# Token icons: sources and terms

Vendored, not fetched at runtime. THE RULE (11 Oct 2026): we use

1. **CC0 and MIT icon sets** at a pinned version (Cryptocurrency Icons, CC0;
   Trust Wallet assets, MIT), where the set's own metadata (name, symbol,
   website) names the project; and
2. **official brand marks, used unmodified to identify a token**: the
   project's own mark from its brand page or brand kit (Solana, Aave, Lighter)
   or, where the project publishes none there, its token image as CoinGecko's
   API serves it (VVV). These are the projects' trademarks, not openly
   licensed: each row states the terms the project gives, or that it gives
   none.

A market for which neither exists is drawn as the **initials circle**.

"Unmodified" means the mark itself is never redrawn, recoloured or combined
with anything. The one placement change is stated in its row: Solana's mark is
not square, so it is scaled uniformly and centred on a disc. Every file was
checked against the actual project, not the ticker: the identity column says
how. Icons are decorative (`aria-hidden`) and used only to identify the token
beside its name.

| File | Asset | Source | Licence / terms | Identity checked by |
|---|---|---|---|---|
| btc.svg | Bitcoin | Cryptocurrency Icons 0.18.1, `svg/color/btc.svg` | CC0 1.0 | set metadata; mark is the ₿ |
| eth.svg | Ethereum | Cryptocurrency Icons 0.18.1, `svg/color/eth.svg` | CC0 1.0 | set metadata; mark is the octahedron |
| sol.svg | Solana | Solana Foundation, https://solana.com/branding, "Logomark SVG" (`solanaLogoMark.svg`, sha256 `3d340110…be1f08a`), fetched 4 Oct 2026 | Solana brand guidelines on that page (no shadows, outlines, stretching, low-contrast backgrounds; keep clearspace) | the project's own page. The mark is not square, so it is scaled UNIFORMLY to 18% and centred on a black disc with clearspace, paths and gradient untouched, because the round `<img>` would otherwise crop it. Replaces the Cryptocurrency Icons file, an old flat variant that rendered as a plain teal circle at 20px |
| lit.svg | Lighter (lighter.xyz) | Lighter, https://lighter.xyz/brand-kit, "LIT" download, `LIT/LIT-TICKER-ICON.svg` (sha256 `3673fde2…a088f01f`), fetched 4 Oct 2026 | Published for download on the project's brand kit; no licence text is stated there. Used unmodified, to identify the token | PRICE. The context says only `LIT`, and two tokens have used that ticker (Litentry, now renamed Heima, and Lighter). On 4 Oct 2026 Perpl's LIT mark was 3.65341; CoinGecko had Lighter at $3.65 and Litentry at $0.14 |
| zec.svg | Zcash | Cryptocurrency Icons 0.18.1, `svg/color/zec.svg` | CC0 1.0 | set metadata |
| uni.svg | Uniswap | Cryptocurrency Icons 0.18.1, `svg/color/uni.svg` | CC0 1.0 | set metadata; mark is the unicorn |
| aave.svg | Aave | Aave, https://aave.com/brand, "Download Kit" (`/aave-brand-assets.zip`), `Aave Brand Assets/Aave Token/Aave Token Round.svg` (sha256 `606a0af5…877ce1df`), fetched 4 Oct 2026 | Aave brand FAQ on that page: the logo may be used on a website provided it is not altered, combined with other logos, or used to misrepresent the brand | the project's own page, its "AAVE Token" asset. Replaces the Cryptocurrency Icons file, the pre-rebrand teal "A" |
| mon.png | Monad (monad.xyz) | Trust Wallet assets, `blockchains/monad/info/logo.png` | MIT | set metadata (website) |
| hype.png | Hyperliquid (hyperliquid.xyz) | Trust Wallet assets, `blockchains/hyperevm/info/logo.png` | MIT | set metadata (website) |
| near.png | NEAR Protocol | Trust Wallet assets, `blockchains/near/info/logo.png` | MIT | set metadata |
| arb.png | Arbitrum | Trust Wallet assets, `blockchains/ethereum/assets/0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1/logo.png` | MIT | set metadata; the ARB token contract |
| ena.png | Ethena (ethena.fi) | Trust Wallet assets, `blockchains/ethereum/assets/0x57e114B691Db790C35207b2e685D4A43181e6061/logo.png` | MIT | set metadata; the ENA token contract |
| morpho.png | Morpho | Trust Wallet assets, `blockchains/ethereum/assets/0x58D97B57BB95320F9a05dC918Aef65434969c2B2/logo.png` | MIT | set metadata; the MORPHO token contract |
| pump.png | pump.fun (pump.fun) | Trust Wallet assets, `blockchains/solana/assets/pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn/logo.png` | MIT | set metadata; the PUMP mint |
| vvv-token.png | Venice Token (VVV) | CoinGecko API, `GET /api/v3/coins/venice-token` → `image.large` (`coin-images.coingecko.com/coins/images/54023/large/VVV_Token_Transparent.png`, 250×250, sha256 `b6644efa…efb0d39f`), fetched 4 Oct 2026, the largest size the API serves | Venice's own token mark, as CoinGecko serves it; a trademark of Venice, used unmodified to identify the token | CoinGecko's record: symbol `vvv`, rank #66 on 4 Oct 2026, and Base contract `0xacfe…21bf`, the same contract the previous file was keyed to. Replaces `vvv.png` (Trust Wallet), which was the Venice AI company logo, a navy mask, not the VVV token's crossed keys |

- **Cryptocurrency Icons** (https://github.com/spothq/cryptocurrency-icons),
  npm package `cryptocurrency-icons@0.18.1`. Public domain dedication:
  `LICENSE-cryptocurrency-icons-CC0.md`.
- **Trust Wallet assets** (https://github.com/trustwallet/assets) at commit
  `bbe582d25a22a0367c25a5e7097ad3e0f75e2287`. The repository ships PNGs, not
  SVGs, so these are PNG. Copyright notice and terms:
  `LICENSE-trustwallet-assets-MIT.txt`.
- Brand-page assets are trademarks of their projects and are not covered by
  either licence file. Their terms are the pages linked in their rows.

**On the fallback** (a neutral circle with the market's initials, drawn in
`apps/web/src/components/TokenIcon.tsx`):

- **TAO** (Bittensor; identity is not in doubt: Perpl's contract mark was
  303.481 against CoinGecko's $303.64 on 4 Oct 2026). Neither the icon sets
  nor a brand page has it. bittensor.com, opentensor.ai and learnbittensor.org
  publish no brand or press page. The τ mark exists in the Opentensor
  Foundation's docs repository (`opentensor/developer-docs`,
  `static/img/bt-docs-logo.svg`), but that repository states no licence, so
  it is not vendored. A wrapped-TAO logo would be a different asset.

A market added later is on the fallback until a file for it is added here, with
its row in this table.
