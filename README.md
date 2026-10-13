<div align="center">

<img src="brand/perpguard-logo.png" width="96" alt="PerpGuard">

<h1>PerpGuard</h1>

<p><b>Two in three liquidations on Perpl hit accounts holding enough to stop them.</b></p>

<p>PerpGuard watches your positions, warns you before liquidation, and tops up margin with one tap in Telegram.</p>

<p>
<a href="https://perpguard.app"><img src="https://img.shields.io/badge/mainnet-live-22c55e?style=flat-square&labelColor=161b22" alt="mainnet: live"></a>
<a href="https://testnet.perpguard.app/bot/guide"><img src="https://img.shields.io/badge/testnet-try%20it%20free-8b5cf6?style=flat-square&labelColor=161b22" alt="testnet: try it free"></a>
<a href="https://t.me/PerpGuardBot"><img src="https://img.shields.io/badge/telegram-%40PerpGuardBot-26a5e4?style=flat-square&labelColor=161b22" alt="telegram: @PerpGuardBot"></a>
<a href="https://github.com/0xMigzy/PerpGuard/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/0xMigzy/PerpGuard/ci.yml?branch=main&label=ci&style=flat-square&labelColor=161b22" alt="ci status"></a>
<img src="https://img.shields.io/badge/tests-1%2C662-22c55e?style=flat-square&labelColor=161b22" alt="tests: 1,662">
<img src="https://img.shields.io/badge/indexed-84M%20events-7c3aed?style=flat-square&labelColor=161b22" alt="indexed: 84M events">
<img src="https://img.shields.io/badge/built%20for-Monad%20Metropolis-836ef9?style=flat-square&labelColor=161b22" alt="built for: Monad Metropolis">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-64748b?style=flat-square&labelColor=161b22" alt="license: MIT"></a>
</p>

</div>

## Overview

Perpl uses isolated margin: each position carries its own collateral, and the account's free balance is never used to save it. So traders get liquidated while holding spare AUSD that would have kept the position open, because nobody was watching.

Since Perpl launched on 11 Feb 2026, 2,426 of 3,653 mainnet liquidations (66.4%) hit accounts whose free balance could have covered the top-up that would have kept the position above maintenance margin. Over the last 30 days: 428 of 634 (67.5%).

![A trader's page on perpguard.app showing how many of their liquidations were rescuable](docs/images/trader-card.png)
*A trader's page: their liquidations over the window, and how many their free balance could have prevented.*

PerpGuard watches each position and warns before liquidation. It adds margin only if the trader has turned that on, for that position.

For anyone trading on Perpl, and for anyone who wants to watch an account on Perpl without trading at all.

<img src="docs/images/telegram-alert.png" width="380" alt="A PerpGuard alert in Telegram"><br>
*The alert: the position, its margin and free balance, and two top-ups, each showing the distance it buys.*

## Screenshots

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/screenshots/alert-to-tx.png" width="420" alt="A Telegram alert saying a BTC long is 2.7% from liquidation, with two top-up buttons, followed by the result of adding 7 AUSD and a transaction link"><br>
<em>A mainnet liquidation warning, the pre-calculated top-up amounts, and the result with its on-chain transaction link.</em>
</td>
<td width="50%" valign="top">
<img src="docs/screenshots/home-mainnet.png" width="420" alt="The PerpGuard bot's home screen for mainnet account 69, with seven buttons"><br>
<em>The bot's home screen on mainnet.</em>
</td>
</tr>
</table>

<img src="docs/screenshots/two-bots.png" width="686" alt="Two Telegram bots in a list: PerpGuard, and PerpGuard | Testnet"><br>
<em>The two bots in Telegram: PerpGuard for mainnet, and PerpGuard | Testnet.</em>

## What it does

![The PerpGuard Overview page](docs/images/dashboard.png)
*The Overview on perpguard.app: volume, fees and active traders over the window picked; open interest and the exchange balance now.*

**Analytics.** A public, read-only site built on a full-history index of the Perpl Exchange on Monad mainnet: Overview, Markets (with a funding heatmap and a comparison against Hyperliquid and Binance), Traders, Liquidations, Risk, and a profile for every account. No sign-in.

**Risk.** Every open position on mainnet is re-priced at each half-percent step from −50% to +50%. The Risk page shows what a 5% or 10% move would liquidate in each direction, the losses beyond collateral, and each market's insurance fund against them.

**The bot.** There are two, one per network, and you pick a network by opening one or the other:

| | Site | Analytics and watching | Actions |
| --- | --- | --- | --- |
| [@PerpGuardBot](https://t.me/PerpGuardBot) | [perpguard.app](https://perpguard.app) | Monad mainnet | Monad mainnet, real funds |
| [@PerpGuardTestnetBot](https://t.me/PerpGuardTestnetBot) | [testnet.perpguard.app](https://testnet.perpguard.app) | Monad mainnet | Monad testnet |

Both read the same mainnet index, so the analytics and the watch tier are identical on the two. Each runs its own backend, database and encryption key, and each names the other where a wallet's account turns out to be on the other network. Each has two tiers.

**Watch, for anyone.** Send either bot any mainnet address or account number. It re-reads the account every 30 seconds and warns at the distances you choose (Standard: 10% and 5% from liquidation). It also reports liquidations and large trades above thresholds you set. Watched accounts get words only. There is nothing to press.

**Act, for a linked account.** Link your Perpl account on the page the bot sends you to: [perpguard.app/link](https://perpguard.app/link) for a mainnet account, [testnet.perpguard.app/link](https://testnet.perpguard.app/link) for a testnet one. At your alert distance (5% by default, or 2, 3, 5, 8, 10%, or anything from 0.5% to 20%) the bot sends one message per position per crossing, with up to two top-ups that fit the free balance and a custom amount. Each amount shows the distance from liquidation it buys. Tapping one shows the margin, liquidation price, distance and free balance before and after. Nothing is sent until you confirm.

📊 My positions shows one button per position, closest to liquidation first. 🚪 Close position is on each position's own screen: it offers 25%, 50%, 75%, a custom percentage or closing everything, each behind a confirmation showing what the close would realise.

🤖 Rescue is off until you turn it on. It adds margin by itself at your alert distance, for one position at a time, and only after you arm it with a tap in the linked chat.

**Every message ends in where to check it.** An alert ends in its time and two links: the wallet's page on the site, and the transaction on MonadVision where the alert has one (a liquidation, a large trade, a watched position's open or close). The result of an action (added margin, a partial or full close, a Rescue top-up) ends in the transaction Perpl reported for it, on that deployment's own network. When there is no hash, there is no link.

**Safety.** See [Safety model](#safety-model).

## Using it

Alerts need no setup: send [@PerpGuardBot](https://t.me/PerpGuardBot) or [@PerpGuardTestnetBot](https://t.me/PerpGuardTestnetBot) any Perpl mainnet address, or `/watch` and an account number, and it starts watching.

To let it act for you, follow the setup guide for the network your Perpl account is on: [perpguard.app/bot/guide](https://perpguard.app/bot/guide) for mainnet, [testnet.perpguard.app/bot/guide](https://testnet.perpguard.app/bot/guide) for testnet.

What each deployment stores, for how long, and what Disconnect deletes is on its privacy page: [perpguard.app/privacy](https://perpguard.app/privacy), [testnet.perpguard.app/privacy](https://testnet.perpguard.app/privacy).

## Data and provenance

| | Mainnet (analytics and watch tier on both bots; actions on @PerpGuardBot) | Testnet (actions on @PerpGuardTestnetBot) |
| --- | --- | --- |
| Chain id | 143 | 10143 |
| Perpl Exchange (proxy) | `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` |

**History.** The index starts at block 54,773,010, the Exchange proxy's deployment block on Monad mainnet (11 Feb 2026). Every liquidation since launch can be judged.

**Events.** 42 of the Exchange's 204 event types are handled: market listings and margin parameters, accounts and deposits, every position change, margin added and removed, liquidations and other forced exits, maker and taker fills, mark updates, and funding settlements. How each one is handled is listed in `apps/indexer/docs/EVENTS.md`.

**Scale.** On 9 Oct 2026, at block 111,884,822, Envio had processed 83.0 million events. The index held 7,563,875 positions and 3,653 liquidations.

**What it stores** (`apps/indexer/schema.graphql`): markets, traders, positions, fills, liquidations, margin actions, collateral flows, funding events, and per-day aggregates by market and by trader.

**Market parameters.** Market ids, tick sizes and scaling are read from Perpl's `GET /v1/pub/context`, never hard-coded.

## Accuracy

Every figure on the site names its window, and [/status](https://perpguard.app/status) names the code that computes each one. The checks below were run on 9 Oct 2026 unless a date says otherwise.

![The open interest reconciliation table on /status](docs/images/status-reconciliation.png)
*Open interest per market, the index beside the venue, each with the block it was read at.*

**The index matches the venue.** Every 5 minutes the backend reads open interest from Perpl's API and, straight after, from the index, each with its block. In the reading above, at 12:56 UTC, the index was at block 111,901,715 and the venue's readings at blocks 111,901,733 to 111,901,763. Seven of 11 markets matched to the lot. The largest gap was NEAR, 1.51% (20.95 lots), then MON 0.57% and BTC 0.034%. The count varies from one check to the next (10 of 11 matched at 11:31 the same day): a gap is trades that landed in the seconds between the two reads. The per-market table is live on /status.

**Funding settles every 2,580 seconds, about 43 minutes, not hourly.** That is `funding_interval_sec` on all 11 markets in Perpl's live context. Over the last 24 hours the index recorded 512 settlement intervals with a median of 2,588 s (range 2,587 to 2,592).

**Adding margin reports failure while applying in full, on testnet and on mainnet.** On Perpl testnet, `IncreasePositionCollateral` returned `st: 7 Failed, sr: 32 OrderDescIdTooLow` while the margin was credited to the micro, four times out of four (29 to 30 Sep 2026; frames in `fixtures/live-action-run-testnet.json`, table in `docs/evidence.md`). On mainnet it did the same on the one top-up measured: on 12 Oct 2026 at 23:25:17 UTC an 11.5 AUSD top-up came back `st: 7 Failed, sr: 32` while the position's margin went from 17.416539 to 28.916539 AUSD, in transaction `0x1926fd3cb0a44f5aa21b736a11b656627d89e1ff0809436a7c71d9bb449d3f9c`, block 112,885,275. PerpGuard therefore judges a top-up by the position's margin before and after, never by the receipt, and never re-sends on that report.

**Not every trader's books reconcile.** For the top 10 accounts by 30-day net P&L, the replay rebuilds each balance from indexed events and compares it with the index's own (free balance plus open margin). Four have more than 3,000 opens in 30 days and are not replayed. Of the other six, one matches exactly (#4532) and five do not, by 2,007.39, 1,077.22, 12.30, −10.42 and −9.42 AUSD. The page says NOT RECONCILED, with the gap, before any figure.

**The index records no per-position fees.** `Position.feesCNS` is empty on all 7,563,875 indexed positions; fees exist per account per UTC day. Win rate, best and worst round trip, and profit factor are therefore before fees, and the site labels them so.

## Safety model

**Trade-only key.** A Perpl API key can place, cancel and change orders, and add margin. Perpl does not allow withdrawals or transfers out with an API key of any scope ([Perpl docs](https://docs.perpl.xyz/resources/for-developers/api/authentication.md)). The key is sealed at rest with AES-256-GCM, is never sent back to a browser, and is never logged.

**Nothing automatic by default.** Alerts carry buttons, and every amount needs a second tap to confirm. Rescue is off on every position until the owner arms it with a tap in the linked chat. The rule is signed when armed, and a rule written any other way (a script, a database edit) is switched off.

**Rescue limits.** Each armed position has four: maximum top-ups, maximum total, a minimum free balance that is never spent, and a cooldown. One rescue runs at a time per account, and amounts in flight are reserved against the free balance.

**The kill switch.** 🆘 Kill switch → "Stop automation only" writes a flag in PerpGuard's database, switches off every Rescue rule, and sends nothing to the exchange, so it works with the connection down. "Stop everything" stops automation first, then closes each position once, after a confirmation showing what it costs.

**One network per deployment.** Analytics and the watch tier read mainnet on both. Margin, close and Rescue act on Perpl mainnet, with real funds, from @PerpGuardBot, and on Perpl testnet from @PerpGuardTestnetBot. A link stores its network, and a wallet or key for the other network is refused by name and pointed at the other bot. The two deployments share no database and no encryption key, so no testnet account record is ever in the mainnet database. In the code, mainnet trading is off unless the operator sets `PERPGUARD_MAINNET_TRADING=1`; the mainnet deployment sets it.

**One network per risk loop.** A position is only ever priced against marks from its own network. The code refuses to build anything else.

### Dynamic

The link page on each site ([perpguard.app/link](https://perpguard.app/link), [testnet.perpguard.app/link](https://testnet.perpguard.app/link)) uses Dynamic to connect the wallet. The backend generates an Ed25519 key, asks Perpl for the enrolment payload, and the wallet signs Perpl's EIP-712 typed data once. The backend verifies the signature (smart-contract wallets included), enrols the key with Perpl, signs in with it to learn the account, and seals it.

The key's secret never reaches the browser, and nobody copies a key by hand. A held key that still works is reused rather than creating another. Pasting an existing key remains available.

**Builder code.** On mainnet, a key PerpGuard creates through that signature carries PerpGuard's Perpl builder code, bound at enrolment with a fee ceiling of 0: attribution only, no builder fee. The wallet prompt names the builder and the ceiling before anything is signed. A pasted key never carries it. The enrolment request declares its origin as https://perpguard.app, the deployment's own site; the backend refuses to start on a declared origin that is not its own site. The testnet deployment declares none.

## How it works

```text
 Monad mainnet (chain 143) · Perpl Exchange proxy
        │                                   │
        │ the whole event history           │ live contract reads, raw logs
        ▼                                   ▼
 Envio HyperSync                      Monad RPC provider
 143.hypersync.xyz                    monad-mainnet.quiknode.pro
        │ no RPC in the path                │
        ▼                                   │
 apps/indexer                               │
 Envio HyperIndex                           │
        │                                   │
        ▼                                   ▼
 Postgres: the mainnet index ───▶ read by BOTH backends
        │
        ├───────────────────────────────────────────┐
        ▼                                           ▼
 apps/backend · mainnet deployment           apps/backend · testnet deployment
 api.perpguard.app                           api-testnet.perpguard.app
 own database, own encryption key            own database, own encryption key
 analytics API and its scheduled jobs        no analytics jobs (they run once)
 risk loops, alerts, Rescue, kill switch     risk loops, alerts, Rescue, kill switch
 Telegram: @PerpGuardBot                     Telegram: @PerpGuardTestnetBot
 Perpl API (REST + WebSocket)                Perpl API (REST + WebSocket)
   reads: mainnet marks, context,              reads: mainnet marks and context,
          positions and balances                      testnet positions and balances
   writes: add margin, close                   writes: add margin, close
           (mainnet, Ed25519-signed)                   (testnet, Ed25519-signed)
        │                                           │
        │ /api/analytics/* (read-only),             │ /link and its own bot only;
        │ for both sites                            │ analytics come from the left
        ▼                                           ▼
 apps/web (Next.js), one codebase, two builds
 perpguard.app                               testnet.perpguard.app
```

Each bot runs inside its backend (grammY, in-process). The two backends are the same code started from two complete env files.

Envio supplies the entire event history, synced over HyperSync with no RPC in the path. A Monad RPC provider answers a small set of live contract reads the history cannot contain, and is also used to verify Envio's output independently by comparing indexed rows against raw logs from a different provider.

TypeScript throughout, in a pnpm workspace. Node 22, PostgreSQL 16, Envio HyperIndex 3.12.1, Fastify 5.12, grammY 1.46, Next.js 15.5 with React 19.3, Tailwind CSS 4.3, Recharts 3.10, viem 2.56, Dynamic SDK 5.9, TypeScript 5.9.

## Run it

Needs Node 22.9 or later, pnpm, PostgreSQL 16, an [Envio HyperSync token](https://docs.envio.dev/docs/HyperSync/api-tokens), and, for the bot, a Telegram bot token from @BotFather.

```bash
git clone https://github.com/0xMigzy/PerpGuard.git && cd PerpGuard && pnpm install
cp .env.example .env    # fill in the Postgres, HyperSync and Telegram values it lists; it also lists what a second deployment's env file changes
pnpm --filter @perpguard/indexer codegen && ENVIO_PERPGUARD_START_BLOCK=54773010 pnpm --filter @perpguard/indexer start
pnpm start & pnpm web   # backend on :8080, then open http://localhost:3000
```

The full backfill from block 54,773,010 took about 14 hours on a 2-vCPU server (1 Oct 2026, 06:12 to 20:28 UTC) and the index is 15 GB today. The site serves figures as soon as the index has data; it catches up block by block.

## Where to look in the code

- `apps/indexer/src/handlers/` — the Envio handlers: positions, fills, liquidations, margin, funding.
- `packages/shared/src/risk/liquidation.ts` — liquidation price and signed buffer, pure functions.
- `packages/shared/src/analytics/exposure.ts` — the ±50% ladder behind the Risk page.
- `packages/shared/src/venues/perpl.ts` — the Perpl venue: signing, sending, reconciling an action against the position.
- `apps/backend/src/rescue/decide.ts` — the pure decision for an automatic top-up, limits first.
- `apps/backend/src/rescue/killSwitch.ts` — the stop that sends nothing to the exchange.
- `apps/backend/src/server/link/walletKey.ts` — one wallet signature to an enrolled, sealed key.
- `apps/web/src/lib/statusContent.ts` — every figure's method, as /status shows it.

## Tests

```bash
pnpm test        # node:test across every package and app
pnpm typecheck
```

1,662 tests, all passing on 13 Oct 2026. CI runs both and a clean web build on every push.

## After the hackathon

* Copy trading.
* Exploring funding arbitrage and delta-neutral positions across other perp venues.

## Monad Metropolis

Track 01, Onchain Finance & Trading. Bounties: Envio, Perpl analytics and risk, Perpl API, Dynamic.

Built during the hackathon: the first commit is dated 26 Sep 2026, and no commit is dated earlier. The only files that predate it are the ones others wrote, listed under Credits.

## Credits

Built on Envio HyperIndex, Fastify, grammY, Next.js, React, Tailwind CSS, Recharts, viem and Dynamic.

Files in this repository that others wrote:

- **The Perpl Exchange ABI** (`apps/indexer/abis/Exchange.json` and `ExchangeErrors.json`) is from Perpl's [dex-sdk](https://github.com/PerplFoundation/dex-sdk), as published in the `perpl-sdk` 0.2.9 crate. MIT, © 2025 Perpl Foundation; the licence text is beside the files. No other code or types are taken from Perpl's SDK: the API client was written from [Perpl's documentation](https://docs.perpl.xyz) and from frames read off the wire.
- **Token icons** (`apps/web/public/tokens/`) are from two CC0 and MIT icon sets (Cryptocurrency Icons, Trust Wallet assets) and official brand marks used unmodified to identify a token: the projects' own brand pages (Solana, Aave, Lighter) and, for VVV, the token's mark as CoinGecko serves it. Each file's source and terms are in `apps/web/public/tokens/SOURCES.md`.

An AI coding assistant helped write the code, tests and documentation. The research, design, data validation and review are mine.

PerpGuard is not affiliated with or endorsed by Perpl or the Monad Foundation.

Released under the [MIT License](LICENSE).
