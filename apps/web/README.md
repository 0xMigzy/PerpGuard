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
