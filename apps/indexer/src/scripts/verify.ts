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
import { PerplVenue, loadNetworkConfig } from "@perpguard/shared";

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

const progress = await db.query(
  `select latest_processed_block, num_events_processed, block_height, start_block
     from chain_metadata where chain_id = 143`,
);
const row = progress.rows[0];
if (!row) {
  console.error("no chain_metadata row: has the indexer ever run?");
  process.exit(1);
}
const behind = Number(row.block_height) - Number(row.latest_processed_block);
console.log(
  `indexed blocks ${row.start_block} .. ${row.latest_processed_block} ` +
    `(${Number(row.num_events_processed).toLocaleString("en-US")} events, ` +
    `${behind.toLocaleString("en-US")} behind head)\n`,
);

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

const openCount = await db.query(
  `select m.name, m."openPositionCount" as counted,
          (select count(*) from "Position" p
             where p.market_id = m.id and p.status = 'OPEN')::int as actual
     from "Market" m`,
);
const openBad = openCount.rows.filter((r) => Number(r.counted) !== Number(r.actual));
record(
  "Market.openPositionCount matches the open Position rows",
  openBad.length === 0,
  openBad.length === 0
    ? "all markets agree"
    : openBad.map((r) => `${r.name}: counter ${r.counted} vs ${r.actual} rows`).join(", "),
);

// ── 3. the rescuable-liquidation figures are populated ──────────────────────
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
  record(
    "liquidation counters are internally consistent",
    Number(l.rescuable) <= Number(l.with_spare) && Number(l.with_spare) <= Number(l.total),
    `${l.total} liquidations, ${l.with_spare} with spare balance, ${l.rescuable} rescuable, ` +
      `${l.unknown_position} with a position we never saw open, ${ausd(l.spare)} of spare AUSD in total`,
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
