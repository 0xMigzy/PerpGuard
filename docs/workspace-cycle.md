# TODO: break the `apps/backend` ↔ `apps/bot` workspace cycle

**Status:** deferred on purpose. `ignoreWorkspaceCycles: true` is set in
`pnpm-workspace.yaml` and is safe there for a stated reason — no task in this
workspace emits anything another task consumes, so the arbitrary order pnpm
falls back to cannot change any result. The moment a task emits, that stops
being true and this has to be done for real.

**Why it is worth doing anyway:** pnpm already refuses to order the tasks and
only runs them because we told it to. The cycle is also a claim about the
architecture that is not quite true — it says the bot and the backend are peers
that each need the other, when in fact the bot needs a *contract* and the
backend needs a *component*.

## What the cycle actually is

`apps/bot` → `apps/backend`, for the alerts and risk layer.
`apps/backend` → `apps/bot`, because `src/server.ts` is the composition root and
starts the bot.

The **module** graph is acyclic: the bot imports the alerts modules, and nothing
in the alerts layer imports the server. Nothing circular is ever evaluated. This
is a package-manifest cycle only.

## The fix, precisely

Moving the contract *types* is most of it but **not all of it**, which is worth
being exact about because it is the difference between the fix working and the
warning still being there afterwards. Three separate things point from the bot at
the backend today.

### 1. Contract types → `packages/shared`

These are shared vocabulary, not implementation, and moving them does not
contradict the stack layout in `CLAUDE.md` — `apps/backend` still owns the alerts
layer, it just stops owning the words used to describe it:

- `AlertTransport`, `AlertMessage`, `AlertAction`, `AlertActionType`,
  `AlertActionIntent`, `AlertKind`, `DeliveryResult`, `AlertConfig`,
  `DEFAULT_ALERT_CONFIG`
- from `risk/types.ts`: `RiskAssessment`, `RiskState`, `MarketConfigs`,
  `TopUpOption`, `TopUpOptions` and the `Severity` / `BlindState` helpers they
  need

`apps/backend/src/alerts/types.ts` and `risk/types.ts` then re-export them, so
nothing inside the backend changes shape.

### 2. Two VALUE imports have to be inverted, not moved

`apps/bot/src/positions.ts` calls `buildMessage` (from `alerts/render.ts`) and
`kindFor` (from `alerts/rules.ts`). That is deliberate and must stay true:
`/positions` and a 3am alert have to read identically, and two renderers would
eventually disagree about the number a trader acts on.

But it is a dependency on the *implementation*, so moving types alone leaves it —
and with it the cycle. Moving `render.ts` and `rules.ts` into `packages/shared`
would be moving the layer, which **is** the thing `CLAUDE.md` forbids.

So invert it instead. `BotDeps` gains one injected function:

```ts
/** Renders an assessment exactly as an alert would. Injected so the bot
 *  never learns how a message is built — only that both paths use one
 *  renderer. */
readonly render: (assessment: RiskAssessment) => AlertMessage;
```

`apps/backend/src/server.ts` supplies it — it already imports both modules — as
`(a) => buildMessage(a, kindFor(a.state), { alerts, market: configs.get(a.marketId) })`.
The bot then imports no alerts implementation at all, and the "one renderer"
guarantee is *strengthened*: the bot can no longer pick a different one.

`DEFAULT_ALERT_CONFIG` in `bot.ts` goes away with step 1 (it moves to shared).

### 3. The two integration tests keep the cycle alive as a devDependency

`apps/bot/src/engine.integration.test.ts` imports `AlertEngine` and the alerts
layer's `test-support`. pnpm counts devDependencies when ordering tasks, so the
warning survives steps 1 and 2 unless this is handled too.

Move that file to `apps/backend/src/alerts/telegram.integration.test.ts`. That is
where it belongs regardless: it asserts how the **engine's retry loop** reacts to
a transport's `retryable` flag, which is a statement about the engine. The
backend already depends on the bot, so the import direction is the one that
already exists. `apps/bot/src/testSupport.ts` also imports
`@perpguard/backend/alerts/test-support` for the real fixture assessments; those
few helpers (`assessOne`, `BTC`, `CONFIGS`, `FIXTURE_BTC`, `FIXTURE_BTC_MARK`)
move to `packages/shared` test support alongside the risk fixtures they are built
from.

## Done when

`ignoreWorkspaceCycles` is removed from `pnpm-workspace.yaml` and
`pnpm typecheck` runs clean with no cycle warning.
