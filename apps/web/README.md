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

## Six sections, all public

Overview, Markets, Traders, Liquidations, Risk and Alerts. Nothing is
session-gated and nothing on any page can execute an action: `src/lib/api.ts`
has GETs against `/api/analytics/*` and nothing else. The backend's
`/api/protect/*` action routes still exist; no page calls them. Actions live
in the Telegram bot.

One timeframe control per section — 24H / 7D / 30D / All, defaulting to 30D —
sits in the header of Overview, Markets, Traders and Liquidations and drives
every query on the page; the tabs carry it between sections. Risk has no
timeframe: it is contract state at one block, and says which.

`docs/frontend-mockup.html` is the layout reference. Its figures are
hand-written; only its structure, density and wording were taken.

Screenshots and smoke builds can be kept apart from a running dev server's
`.next` with `NEXT_DIST_DIR=.next-build npx next build` and the same variable
on `next start`.
