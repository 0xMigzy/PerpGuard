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

## Protect

`/protect` is private. It signs in with a one-time code the Telegram bot hands
the linked chat (`/web`), which opens an HttpOnly session cookie; every
`/api/protect/*` route answers 401 without it and the page shows nothing about
the account until then. For local work set `PERPGUARD_WEB_DEV_LINK=1` on the
backend and mint a code from its own host: `curl http://127.0.0.1:8080/dev/link-code`.

Every button goes through the same actions layer as the bot, with the same
confirmation text, and the outcome shows the venue's reported status beside
what the position actually did.
