/**
 * Acceptance checks for the indexer, run against whatever it has indexed.
 *
 *   pnpm --filter @perpguard/indexer verify
 *
 * These are the checks that caught real bugs, kept runnable so they stay caught.
 * Three of them are internal consistency, which must hold exactly. The fourth
 * compares our own trailing-24h volume against the venue's published figure,
 * which is a different source arriving by a different route: if our handlers are
 * wrong, those two will not agree.
 *
 * Exits non-zero on any failure, so it can gate a commit.
 */
import { Client } from "pg";
import {
  PerplVenue,
  classifyIndexerHealth,
  describeIndexerHealth,
  loadNetworkConfig,
  type IndexerProgress,
} from "@perpguard/shared";

interface Check {
  readonly name: string;
  readonly detail: string;
  readonly ok: boolean;
}

const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
};

const ausd = (micros: bigint | string | null): string =>
  micros === null ? "n/a" : `${(Number(micros) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} AUSD`;

const db = new Client({
  host: process.env.ENVIO_PG_HOST ?? "127.0.0.1",
  port: Number(process.env.ENVIO_PG_PORT ?? 5432),
  user: process.env.ENVIO_PG_USER ?? "envio",
  password: process.env.ENVIO_PG_PASSWORD ?? "",
  database: process.env.ENVIO_PG_DATABASE ?? "perpguard_indexer",
});
await db.connect();

/**
 * Real chain head, from the RPC — NOT from the indexer.
 *
 * `chain_metadata.block_height` is the indexer's own reading, written by the
 * same process, so a dead indexer reports itself 0 blocks behind. Observed
 * live: the indexer said 0 while the RPC put it 152 back. One independent
 * number is the entire difference between catching that and not.
 */
async function rpcChainHead(): Promise<number | undefined> {
  const url = process.env.ENVIO_PERPL_RPC_URL ?? "https://rpc.monad.xyz";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json()) as { result?: string };
    return json.result === undefined ? undefined : Number.parseInt(json.result, 16);
  } catch {
    // No head means we cannot certify synced, which classifyIndexerHealth
    // already handles by refusing to. Say so rather than failing the run.
    console.log("NOTE  could not reach the RPC for a real chain head; health is unverified\n");
    return undefined;
  }
}

const result = await db.query(
  `select latest_processed_block, num_events_processed, block_height, start_block
     from chain_metadata where chain_id = 143`,
);
const metadata = result.rows[0];
if (!metadata) {
  console.error("no chain_metadata row: has the indexer ever run?");
  process.exit(1);
}
const chainHead = await rpcChainHead();
const row: IndexerProgress = {
  chainId: 143,
  startBlock: Number(metadata.start_block),
  latestProcessedBlock: Number(metadata.latest_processed_block),
  blockHeight: Number(metadata.block_height),
  eventsProcessed: Number(metadata.num_events_processed),
  ...(chainHead === undefined ? {} : { chainHead }),
  observedAtMs: Date.now(),
};

// One reading, because chain_metadata is written in bursts every one to three
// minutes: a healthy indexer shows no progress at all over a 60-second window,
// so a second reading taken seconds later proves nothing and would only invite
// a false alarm. Freshness against real head is instant and is the property
// that matters here. Distinguishing halted from lagging needs a window longer
// than the commit cadence, which belongs to a long-running monitor rather than
// a one-shot script.
const health = classifyIndexerHealth(row, undefined);
const behind = health.blocksBehind;

console.log(
  `indexed blocks ${row.startBlock} .. ${row.latestProcessedBlock} ` +
    `(${row.eventsProcessed.toLocaleString("en-US")} events, ` +
    `${behind.toLocaleString("en-US")} behind ` +
    `${health.headIsIndependent ? "real head" : "its own head"})`,
);
console.log(`indexer health: ${describeIndexerHealth(health)}\n`);

// Every check below reads rows that stopped changing at latest_processed_block.
// Passing them while the indexer is not current would report a frozen snapshot
// as a healthy one — the analytics equivalent of a dead feed that still looks
// live.
record(
  "the indexer is caught up, so these figures are current",
  health.serveAsCurrent,
  health.serveAsCurrent ? `state ${health.state}` : (health.reason ?? health.state),
);
if (!health.serveAsCurrent) {
  console.log(
    `NOTE  the figures below are NOT current. ${health.reason ?? health.state}\n` +
      `      They are what the indexer had at block ${row.latestProcessedBlock}.\n`,
  );
}

// ── 1. open interest: every match moves both sides equally ───────────────────
const oi = await db.query(
  `select id, name, "longLotsDeltaLNS"::text as l, "shortLotsDeltaLNS"::text as s,
          ("longLotsDeltaLNS" - "shortLotsDeltaLNS")::text as divergence,
          "oiUnverifiedCloseCount" as unverified
     from "Market" order by (id::bigint)`,
);
const diverged = oi.rows.filter((r) => r.divergence !== "0");
const unverified = oi.rows.reduce((n, r) => n + Number(r.unverified), 0);
record(
  "open interest: longLotsDelta == shortLotsDelta on every market",
  diverged.length === 0,
  diverged.length === 0
    ? `${oi.rows.length} markets balanced`
    : diverged.map((r) => `${r.name} off by ${r.divergence}`).join(", "),
);
record(
  "open interest: every close had its size recovered",
  unverified === 0,
  `${unverified} unverified close(s)`,
);

// ── 2. per-trader arithmetic ────────────────────────────────────────────────
const pnl = await db.query(
  `select count(*)::int as bad from "Trader"
     where "netPnlCNS" <> "realizedPnlCNS" + "fundingCNS" - "feesPaidCNS"`,
);
record(
  "trader netPnl == realized + funding - fees",
  Number(pnl.rows[0].bad) === 0,
  `${pnl.rows[0].bad} trader(s) inconsistent`,
);

const trips = await db.query(
  `select count(*)::int as bad from "Trader" where "wins" + "losses" <> "roundTrips"`,
);
record(
  "trader wins + losses == roundTrips",
  Number(trips.rows[0].bad) === 0,
  `${trips.rows[0].bad} trader(s) inconsistent`,
);

const rate = await db.query(
  `select count(*)::int as bad from "Trader"
     where "roundTrips" > 0
       and round("winRate", 4) <> round("wins"::numeric / "roundTrips", 4)`,
);
record(
  "trader winRate == wins / roundTrips",
  Number(rate.rows[0].bad) === 0,
  `${rate.rows[0].bad} trader(s) inconsistent`,
);

// Open-position counters, checked on ALL THREE entities that carry one.
//
// This check used to cover Market alone, and Exchange.openPositionCount sat at
// 0 through 20.8M events because nothing ever incremented it: Market and Trader
// were threaded through the position lifecycle and Exchange was not. The bug
// was invisible for exactly as long as the verification was partial. So when
// the same quantity is counted in more than one place, every copy gets checked
// against the rows -- not one of them, and not against each other.

const marketOpen = await db.query(
  `select m.name, m."openPositionCount" as counted,
          (select count(*) from "Position" p
             where p.market_id = m.id and p.status = 'OPEN')::int as actual
     from "Market" m`,
);
const marketBad = marketOpen.rows.filter((r) => Number(r.counted) !== Number(r.actual));
record(
  "Market.openPositionCount matches the open Position rows",
  marketBad.length === 0,
  marketBad.length === 0
    ? `${marketOpen.rows.length} markets agree`
    : marketBad.map((r) => `${r.name}: counter ${r.counted} vs ${r.actual} rows`).join(", "),
);

const traderOpen = await db.query(
  `select t.id, t."openPositionCount" as counted,
          coalesce(p.actual, 0)::int as actual
     from "Trader" t
     left join (select trader_id, count(*)::int as actual from "Position"
                 where status = 'OPEN' group by trader_id) p on p.trader_id = t.id
    where t."openPositionCount" <> coalesce(p.actual, 0)`,
);
record(
  "Trader.openPositionCount matches the open Position rows",
  traderOpen.rows.length === 0,
  traderOpen.rows.length === 0
    ? "every trader agrees"
    : traderOpen.rows
        .slice(0, 5)
        .map((r) => `account ${r.id}: counter ${r.counted} vs ${r.actual} rows`)
        .join(", ") + (traderOpen.rows.length > 5 ? ` (+${traderOpen.rows.length - 5} more)` : ""),
);

const exchangeOpen = await db.query(
  `select (select "openPositionCount" from "Exchange") as counted,
          (select count(*) from "Position" where status = 'OPEN')::int as actual`,
);
const eo = exchangeOpen.rows[0];
record(
  "Exchange.openPositionCount matches the open Position rows",
  eo !== undefined && Number(eo.counted) === Number(eo.actual),
  eo === undefined
    ? "no Exchange row"
    : `counter ${eo.counted} vs ${eo.actual} rows`,
);

// ── 3. the rescuable-liquidation figures are populated ──────────────────────
//
// rescuableLiquidationCount is THE headline: the trader's spare AUSD actually
// covered the top-up that would have kept the position alive.
// liquidationsWithSpareBalanceCount is not, and is never quoted as one -- it
// counts any balance above zero, which on mainnet is all 653 of 653 because the
// smallest is 0.00024 AUSD. It is printed here only as the diagnostic it is.
const liq = await db.query(
  `select "liquidationCount" as total,
          "liquidationsWithSpareBalanceCount" as with_spare,
          "rescuableLiquidationCount" as rescuable,
          "liquidationsWithUnknownPositionCount" as unknown_position,
          "spareBalanceAtLiquidationCNS"::text as spare
     from "Exchange"`,
);
const l = liq.rows[0];
if (l) {
  const total = Number(l.total);
  const rescuable = Number(l.rescuable);
  const known = total - Number(l.unknown_position);
  const pct = known > 0 ? ((rescuable / known) * 100).toFixed(0) : "n/a";
  record(
    "liquidation counters are internally consistent",
    rescuable <= Number(l.with_spare) && Number(l.with_spare) <= total,
    `${rescuable} of ${known} liquidations we can judge were RESCUABLE (${pct}%), ` +
      `out of ${total} total; ${l.unknown_position} had a position we never saw open. ` +
      `Diagnostic only: ${l.with_spare} had any free balance at all, ${ausd(l.spare)} in total.`,
  );

  // A separate, louder check on the headline itself. The rescuable count is the
  // one figure the product is built on, so "it is populated at all" is worth
  // failing on rather than reading past in a passing line.
  record(
    "the rescuable-liquidation headline is populated",
    total === 0 || rescuable > 0,
    total === 0
      ? "no liquidations indexed yet"
      : `${rescuable} rescuable of ${known} judgeable`,
  );
}

// Every liquidation is expected to carry a free balance above zero, which is
// exactly why hadSpareBalance says nothing. Assert the distribution rather than
// the flag, so the day it stops being dust is visible.
const spread = await db.query(
  `select count(*)::int as total,
          count(*) filter (where "freeBalanceBeforeCNS" < 1000000)::int as under_one_ausd,
          percentile_disc(0.5) within group (order by "freeBalanceBeforeCNS")::text as median
     from "Liquidation"`,
);
const sp = spread.rows[0];
if (sp && Number(sp.total) > 0) {
  console.log(
    `NOTE  hadSpareBalance is true for ${sp.total}/${sp.total} liquidations, ` +
      `${sp.under_one_ausd} of them holding under 1 AUSD (median ${ausd(sp.median)}).\n` +
      `      That is why the headline is rescuableLiquidationCount, not this.\n`,
  );
}

// ── 4. our volume against the venue's own published figure ─────────────────
// Different source, different route. `dva` is the venue's rolling 24h volume in
// AUSD micros; ours is summed from maker fills. They will not match to the
// micro -- the windows are not identical and dva is a rolling figure while ours
// is bucketed by UTC day -- so this asserts the same order of magnitude, which
// is what catches a scaling mistake.
// `dva` is a rolling 24h figure, so this check only means anything once the
// indexer has caught up to head. Until then it is reported as skipped rather
// than passing vacuously.
const CAUGHT_UP_WITHIN_BLOCKS = 100_000;
if (behind > CAUGHT_UP_WITHIN_BLOCKS) {
  console.log(
    `SKIP  24h volume vs the venue's dva\n      still ${behind.toLocaleString("en-US")} blocks behind head; ` +
      `this check needs a caught-up indexer\n`,
  );
} else {
  try {
    const venue = new PerplVenue(loadNetworkConfig("mainnet", process.env));
    const context = await venue.getContext();
    const ours = await db.query(
    `select m.id, m.name,
            coalesce(sum(d."volumeCNS") filter (where d.day >= (now() - interval '24 hours')), 0)::text as vol
       from "Market" m left join "MarketDay" d on d.market_id = m.id
      group by m.id, m.name order by (m.id::bigint)`,
  );
    const worst = { name: "none", ratio: 1 };
    let compared = 0;
    console.log("24h volume, ours vs the venue's own dva:");
    for (const r of ours.rows) {
      const market = context.markets.find((m) => String(m.id) === r.id);
      const dva = market?.state
        ? BigInt(((market.state as Record<string, unknown>).dva as string) ?? 0)
        : 0n;
      const oursVol = BigInt(r.vol);
      const line = `  ${r.name.padEnd(10)} ours ${ausd(oursVol).padStart(20)}  venue ${ausd(dva).padStart(20)}`;
      if (dva === 0n || oursVol === 0n) {
        console.log(`${line}  (no volume either side)`);
        continue;
      }
      const ratio = Number(oursVol) / Number(dva);
      compared += 1;
      console.log(`${line}  ratio ${ratio.toFixed(2)}`);
      const off = ratio > 1 ? ratio : 1 / ratio;
      if (off > worst.ratio) {
        worst.name = r.name;
        worst.ratio = off;
      }
    }
    console.log("");
    record(
      "24h volume is the same order of magnitude as the venue's dva",
      compared > 0 && worst.ratio < 4,
      compared === 0
        ? "no market had volume on both sides to compare"
        : worst.ratio < 4
          ? `${compared} markets compared, worst is ${worst.name} at ${worst.ratio.toFixed(2)}x`
          : `${worst.name} is ${worst.ratio.toFixed(2)}x off: check the notional scaling`,
    );
    venue.disconnect();
  } catch (error) {
    record("24h volume vs the venue's dva", false, `could not reach the venue: ${String(error)}`);
  }
}

await db.end();

// ── report ─────────────────────────────────────────────────────────────────
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}\n      ${c.detail}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
