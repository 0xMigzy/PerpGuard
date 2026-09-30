# PerpGuard web

The dashboard. Next.js App Router, Tailwind, Recharts, dark only.

```sh
pnpm web            # http://localhost:3000, backend expected on BACKEND_URL (default :8080)
```

Every number on every page comes from the backend: `/api/analytics/*` and
`/health`, proxied by `next.config.ts`. The browser never reads Postgres, the
indexer or the venue. Types are imported from `@perpguard/shared` as types only.

The backend serves the analytics API only when `INDEXER_DATABASE_URL` is set
(see `.env.example`). Without it every figure stays a skeleton and the header
dot is red, which is the correct picture of a backend with no data.

Pure helpers live in `src/lib` and have `node --test` tests; nothing in there
does I/O.

## Protect and Alerts

`/protect` and `/alerts` are private. Both sit behind one gate: every
`/api/protect/*` route answers 401 without a session cookie, and the pages show
nothing about the account until the backend has confirmed one. Three ways in,
one shape out:

- **Wallet, through Dynamic.** The user signs in with the wallet that owns
  their Perpl account. The backend verifies Dynamic's JWT against the
  environment's public keys and reads the account off the Exchange contract
  from that address (`getAccountByAddr`). No API key, seed phrase or
  fund-moving signature is involved at any step. Needs the same environment id
  in `DYNAMIC_ENVIRONMENT_ID` (backend) and `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID`
  (web); without them the card says wallet sign-in is not configured. The
  `NEXT_PUBLIC_` value is inlined at `next build`, so a deployment that
  turns wallet sign-in on has to be built with it set, not only started.
- **A code from the bot.** The Telegram bot hands the linked chat a one-time
  code (`/web`). For local work set `PERPGUARD_WEB_DEV_LINK=1` on the backend
  and mint one from its own host: `curl http://127.0.0.1:8080/dev/link-code`.
  Ignored when `NODE_ENV=production`.
- **Demo, read-only.** With `PERPGUARD_DEMO_ACCOUNT=1` on the backend anyone
  may open a read-only session on the account it monitors, and a wallet that
  owns no account there gets one instead of a refusal. Every number is live;
  every action is refused by the backend, whatever the page renders. For the
  judge-facing deployment of PerpGuard's own testnet account only.

A session carries a `role` (`owner` may act, `demo` may look) and a `method`
(`dynamic`, `code`, `demo`), and the page says which it is.

Every button goes through the same actions layer as the bot, with the same
confirmation text, and the outcome shows the venue's reported status beside
what the position actually did.
