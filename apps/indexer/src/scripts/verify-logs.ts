/**
 * The index against the chain's own logs, range by range.
 *
 *   pnpm verify:logs                       # 14 ranges of 1,000 blocks, written to docs/verification/
 *   pnpm verify:logs --ranges 20 --size 300
 *
 * Fourteen block ranges spread evenly from the Exchange's deployment block to the
 * index's latest processed block. For each one, raw `eth_getLogs` on the Exchange
 * PROXY (the only emitter), decoded with the saved ABI, is compared with the rows
 * the index wrote for the same blocks — IN BOTH DIRECTIONS, so a missed log and an
 * invented row both show:
 *
 *   MakerOrderFilled(V2)                       -> Trade           by txHash + logIndex
 *   PositionLiquidated / Deleveraged(V2) /
 *   Unwound(V2) / UnwoundWithoutPayment(V2)    -> Liquidation     by txHash + logIndex
 *   CollateralDeposit / CollateralWithdrawal   -> CollateralFlow  by txHash + logIndex
 *   IncreasePositionCollateral /
 *   PositionCollateralDecreased /
 *   CollateralDecrease{Requested,RequestCancelled,
 *   RequestExpired,Declined}                   -> MarginAction    by txHash + logIndex
 *   FundingEventCompleted                      -> FundingEvent    by market + funding block
 *   PositionOpened(V2) / PositionInverted      -> Position        by market + account + transaction
 *
 * MarginAction is written only while the position is live (margin.ts), so a chain
 * log with no row is reported as `skippedByDesign`, never as matched and never as
 * missing; an index row with no log is still a failure. FundingEvent stores no
 * transaction, so it is matched by its own key. A Position stores the transaction
 * that opened it but not the log, so opens match by market, account and
 * transaction; a position ADOPTED mid-life (first seen on a non-open event) would
 * show as extra, and on a full-history index there should be none. Every other event is COUNTED and
 * listed as not compared per log: the index keeps no row per log for it.
 *
 * The ranges are a function of the two endpoints only, so a re-run against the
 * same head picks the same blocks. Read-only on both sides.
 *
 * A SECOND, TARGETED PASS follows, reported separately: evenly spaced blocks
 * almost never contain a liquidation (they are ~3,500 in 55M blocks), and the
 * liquidation finding is the one this product quotes. So 14 more ranges are
 * centred on liquidations spread evenly through the index's own list. Chosen
 * FROM the index, they cannot reveal a liquidation it missed elsewhere; within
 * each range every log is still compared both ways.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { decodeEventLog, toEventSelector, type Abi, type AbiEvent, type Hex } from "viem";

const DEPLOY_BLOCK = 54_773_010;
const PROXY = "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F";
/** The RPC refuses wider than this; ranges larger than it are paged. */
const RPC_MAX_SPAN = 1_000;

const { values: args } = parseArgs({
  options: {
    ranges: { type: "string", default: "14" },
    size: { type: "string", default: "1000" },
    out: { type: "string" },
  },
});
const RANGES = Number(args.ranges);
const SIZE = Number(args.size);

const rpcUrl = process.env.PERPL_MAINNET_RPC_URL?.trim() || process.env.ENVIO_PERPL_RPC_URL?.trim() || "https://rpc.monad.xyz";
const dbUrl = process.env.INDEXER_DATABASE_URL;
if (!dbUrl) throw new Error("INDEXER_DATABASE_URL is not set");

const abi = JSON.parse(readFileSync(new URL("../../abis/Exchange.json", import.meta.url), "utf8")) as Abi;

// ── which events become which rows ──────────────────────────────────────────

type Entity = "Trade" | "Liquidation" | "CollateralFlow" | "MarginAction" | "FundingEvent" | "Position";
const ENTITY_OF: Record<string, Entity> = {
  MakerOrderFilled: "Trade",
  MakerOrderFilledV2: "Trade",
  PositionLiquidated: "Liquidation",
  PositionDeleveraged: "Liquidation",
  PositionDeleveragedV2: "Liquidation",
  PositionUnwound: "Liquidation",
  PositionUnwoundV2: "Liquidation",
  PositionUnwoundWithoutPayment: "Liquidation",
  PositionUnwoundWithoutPaymentV2: "Liquidation",
  CollateralDeposit: "CollateralFlow",
  CollateralWithdrawal: "CollateralFlow",
  IncreasePositionCollateral: "MarginAction",
  PositionCollateralDecreased: "MarginAction",
  CollateralDecreaseRequested: "MarginAction",
  CollateralDecreaseRequestCancelled: "MarginAction",
  CollateralDecreaseRequestExpired: "MarginAction",
  CollateralDecreaseDeclined: "MarginAction",
  FundingEventCompleted: "FundingEvent",
  PositionOpened: "Position",
  PositionOpenedV2: "Position",
  PositionInverted: "Position",
};
/**
 * topic0 -> event name, built once. Only the compared events are fully decoded;
 * the rest (about 99 logs in 100 are order traffic) are named off the topic and
 * counted, which is what made the first version of this script crawl.
 */
const NAME_OF = new Map<string, string>(
  (abi.filter((item) => item.type === "event") as AbiEvent[]).map((event) => [toEventSelector(event).toLowerCase(), event.name]),
);
const ENTITIES: readonly Entity[] = ["Position", "Trade", "Liquidation", "CollateralFlow", "MarginAction", "FundingEvent"];

// ── the chain side ──────────────────────────────────────────────────────────

interface RpcLog {
  readonly blockNumber: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.result !== undefined) return body.result;
    if (attempt >= 4) throw new Error(`${method}: ${body.error?.message ?? response.status}`);
    await new Promise((r) => setTimeout(r, 1_000 * attempt));
  }
}

/** Logs in [from, to], paged under the RPC's span limit and halved if a page is refused as too large. */
async function getLogs(from: number, to: number): Promise<RpcLog[]> {
  if (to - from + 1 > RPC_MAX_SPAN) {
    const mid = from + RPC_MAX_SPAN - 1;
    return [...(await getLogs(from, mid)), ...(await getLogs(mid + 1, to))];
  }
  try {
    return await rpc<RpcLog[]>("eth_getLogs", [{ address: PROXY, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
  } catch (error) {
    if (from === to) throw error;
    const mid = Math.floor((from + to) / 2);
    return [...(await getLogs(from, mid)), ...(await getLogs(mid + 1, to))];
  }
}

async function blockTime(block: number): Promise<Date> {
  const b = await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
  return new Date(Number(BigInt(b.timestamp)) * 1000);
}

// ── the index side ──────────────────────────────────────────────────────────

const db = new Client({ connectionString: dbUrl });
await db.connect();

/**
 * Row keys the index holds for blocks [from, to]. The timestamp bound is there
 * for the index on it (there is none on blockNumber); the block bound decides.
 */
async function indexKeys(entity: Entity, from: number, to: number, t0: Date, t1: Date): Promise<Set<string>> {
  if (entity === "Position") {
    const { rows } = await db.query<{ id: string }>(
      `select market_id || '-' || trader_id || '-' || lower("openTxHash") as id from "Position"
        where "openedAt" between $3 and $4 and "openedBlock" between $1 and $2`,
      [from, to, t0, t1],
    );
    return new Set(rows.map((r) => r.id));
  }
  const { rows } = await db.query<{ id: string }>(
    `select lower(id) as id from "${entity}"
      where timestamp between $3 and $4 and "blockNumber" between $1 and $2`,
    [from, to, t0, t1],
  );
  return new Set(rows.map((r) => r.id));
}

// ── one range ───────────────────────────────────────────────────────────────

interface EntityResult {
  chainLogs: number;
  indexRows: number;
  matched: number;
  missing: string[];
  extra: string[];
  skippedByDesign?: number;
}

async function verifyRange(from: number, to: number) {
  const logs = await getLogs(from, to);
  const [t0, t1] = await Promise.all([blockTime(from), blockTime(to)]);

  const chain = new Map<Entity, Set<string>>(ENTITIES.map((e) => [e, new Set<string>()]));
  // For a margin log the index has no row for: whose position, and when.
  const marginOwner = new Map<string, { perpId: string; accountId: string; block: number }>();
  const notCompared: Record<string, number> = {};
  let undecodable = 0;
  for (const log of logs) {
    const name = NAME_OF.get((log.topics[0] ?? "").toLowerCase());
    if (name === undefined) {
      undecodable += 1;
      continue;
    }
    const entity = ENTITY_OF[name];
    if (entity === undefined) {
      notCompared[name] = (notCompared[name] ?? 0) + 1;
      continue;
    }
    let params: Record<string, unknown>;
    try {
      params = (decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data }).args ?? {}) as Record<string, unknown>;
    } catch {
      undecodable += 1;
      continue;
    }
    const key =
      entity === "FundingEvent"
        ? `${params.perpId}-${params.fundingEventBlock}`
        : entity === "Position"
          ? `${params.perpId}-${params.accountId}-${log.transactionHash.toLowerCase()}`
          : `${log.transactionHash.toLowerCase()}-${Number(BigInt(log.logIndex))}`;
    chain.get(entity)!.add(key);
    if (entity === "MarginAction") {
      marginOwner.set(key, { perpId: String(params.perpId), accountId: String(params.accountId), block: Number(BigInt(log.blockNumber)) });
    }
  }

  const entities = {} as Record<Entity, EntityResult>;
  for (const entity of ENTITIES) {
    const onChain = chain.get(entity)!;
    const inIndex = await indexKeys(entity, from, to, t0, t1);
    // A funding row's blockNumber is the event's; its key is the funding block,
    // which can fall outside the range. Look those keys up directly.
    if (entity === "FundingEvent") {
      const { rows } = await db.query<{ id: string }>(`select lower(id) as id from "FundingEvent" where id = any($1)`, [[...onChain]]);
      for (const r of rows) inIndex.add(r.id);
    }
    const missing = [...onChain].filter((k) => !inIndex.has(k));
    const extra = [...inIndex].filter((k) => !onChain.has(k));
    const result: EntityResult = { chainLogs: onChain.size, indexRows: inIndex.size, matched: onChain.size - missing.length, missing, extra };
    if (entity === "MarginAction") {
      // margin.ts writes a row only while a position is live. CHECKED, not
      // assumed: a log is skipped by design only if the index had no position
      // open for that market and account at that block. Anything else is missing.
      const real: string[] = [];
      let skipped = 0;
      for (const key of missing) {
        const o = marginOwner.get(key)!;
        const { rows } = await db.query(
          `select 1 from "Position" where market_id = $1 and trader_id = $2
              and "openedBlock" <= $3 and ("closedBlock" is null or "closedBlock" >= $3) limit 1`,
          [o.perpId, o.accountId, o.block],
        );
        if (rows.length > 0) real.push(key);
        else skipped += 1;
      }
      result.skippedByDesign = skipped;
      result.missing = real;
      result.matched = onChain.size - missing.length;
    }
    entities[entity] = result;
  }
  return { from, to, fromTime: t0.toISOString(), toTime: t1.toISOString(), logs: logs.length, undecodable, entities, notComparedPerLog: notCompared };
}

// ── the run ─────────────────────────────────────────────────────────────────

const meta = await db.query<{ latest: string }>(`select latest_processed_block::text as latest from chain_metadata where chain_id = 143`);
const head = Number(meta.rows[0]!.latest);
const span = head - SIZE + 1 - DEPLOY_BLOCK;
const starts = Array.from({ length: RANGES }, (_, i) => DEPLOY_BLOCK + Math.floor((i * span) / Math.max(1, RANGES - 1)));

console.log(`index head ${head}; ${RANGES} ranges of ${SIZE} blocks from ${DEPLOY_BLOCK}; rpc ${new URL(rpcUrl).host}`);
const ranges: Awaited<ReturnType<typeof verifyRange>>[] = [];
for (const start of starts) {
  const r = await verifyRange(start, start + SIZE - 1);
  ranges.push(r);
  const line = ENTITIES.map((e) => {
    const x = r.entities[e];
    const bad = x.missing.length + x.extra.length;
    return `${e} ${x.matched}/${x.chainLogs}${bad ? ` (${x.missing.length} missing, ${x.extra.length} extra)` : ""}${x.skippedByDesign ? ` +${x.skippedByDesign} no live position` : ""}`;
  }).join(" · ");
  console.log(`${r.from}–${r.to} ${r.fromTime.slice(0, 10)}: ${r.logs} logs · ${line}${r.undecodable ? ` · ${r.undecodable} undecodable` : ""}`);
}

// ── the targeted pass: ranges centred on liquidations ──────────────────────

const liqRows = await db.query<{ block: string }>(`select "blockNumber"::text as block from "Liquidation" where "blockNumber" <= $1 order by "blockNumber"`, [head]);
const liqBlocks = liqRows.rows.map((r) => Number(r.block));
const picks = liqBlocks.length === 0 ? [] : Array.from({ length: Math.min(RANGES, liqBlocks.length) }, (_, i) => liqBlocks[Math.floor((i * (liqBlocks.length - 1)) / Math.max(1, Math.min(RANGES, liqBlocks.length) - 1))]!);
console.log(`\ntargeted: ${picks.length} ranges centred on liquidations, from ${liqBlocks.length} in the index`);
const targeted: Awaited<ReturnType<typeof verifyRange>>[] = [];
for (const block of picks) {
  const from = Math.max(DEPLOY_BLOCK, block - Math.floor(SIZE / 2));
  const r = await verifyRange(from, Math.min(head, from + SIZE - 1));
  targeted.push(r);
  console.log(`${r.from}–${r.to} ${r.fromTime.slice(0, 10)}: ${r.logs} logs · ` + ENTITIES.map((e) => { const x = r.entities[e]; const bad = x.missing.length + x.extra.length; return `${e} ${x.matched}/${x.chainLogs}${bad ? ` (${x.missing.length} missing, ${x.extra.length} extra)` : ""}`; }).join(" · "));
}

function totalsOf(set: readonly Awaited<ReturnType<typeof verifyRange>>[]) {
  return Object.fromEntries(
    ENTITIES.map((e) => {
      const sum = (f: (x: EntityResult) => number) => set.reduce((s, r) => s + f(r.entities[e]), 0);
      return [
        e,
        {
          chainLogs: sum((x) => x.chainLogs),
          indexRows: sum((x) => x.indexRows),
          matched: sum((x) => x.matched),
          missing: sum((x) => x.missing.length),
          extra: sum((x) => x.extra.length),
          ...(e === "MarginAction" ? { skippedByDesign: sum((x) => x.skippedByDesign ?? 0) } : {}),
        },
      ];
    }),
  ) as Record<Entity, { chainLogs: number; indexRows: number; matched: number; missing: number; extra: number; skippedByDesign?: number }>;
}
const targetedTotals = totalsOf(targeted);

const totals = Object.fromEntries(
  ENTITIES.map((e) => {
    const sum = (f: (x: EntityResult) => number) => ranges.reduce((s, r) => s + f(r.entities[e]), 0);
    return [
      e,
      {
        chainLogs: sum((x) => x.chainLogs),
        indexRows: sum((x) => x.indexRows),
        matched: sum((x) => x.matched),
        missing: sum((x) => x.missing.length),
        extra: sum((x) => x.extra.length),
        ...(e === "MarginAction" ? { skippedByDesign: sum((x) => x.skippedByDesign ?? 0) } : {}),
      },
    ];
  }),
);
const notComparedPerLog: Record<string, number> = {};
for (const r of ranges) for (const [k, v] of Object.entries(r.notComparedPerLog)) notComparedPerLog[k] = (notComparedPerLog[k] ?? 0) + v;
const blocksCovered = RANGES * SIZE;
const logsTotal = ranges.reduce((s, r) => s + r.logs, 0);
const failures =
  Object.values(totals).reduce((s, t) => s + t.missing + t.extra, 0) +
  Object.values(targetedTotals).reduce((s, t) => s + t.missing + t.extra, 0);

const report = {
  _note: "Written by apps/indexer/src/scripts/verify-logs.ts. Re-run with `pnpm verify:logs`.",
  ranAt: new Date().toISOString(),
  chainId: 143,
  exchangeProxy: PROXY,
  rpcHost: new URL(rpcUrl).host,
  indexHead: head,
  deployBlock: DEPLOY_BLOCK,
  sample: {
    ranges: RANGES,
    blocksPerRange: SIZE,
    blocksCovered,
    blocksIndexed: head - DEPLOY_BLOCK + 1,
    shareOfIndexedBlocks: blocksCovered / (head - DEPLOY_BLOCK + 1),
    logsCompared: logsTotal,
  },
  verdict: failures === 0 ? "every compared log matched" : `${failures} mismatch(es)`,
  totals,
  undecodable: ranges.reduce((s, r) => s + r.undecodable, 0),
  notComparedPerLog,
  ranges,
  targeted: {
    _note:
      "Ranges centred on liquidations spread evenly through the index's own list. Chosen from the index, so they cannot reveal a liquidation it missed elsewhere; within each range every log is compared both ways.",
    liquidationsInIndex: liqBlocks.length,
    ranges: targeted.length,
    logsCompared: targeted.reduce((s, r) => s + r.logs, 0),
    totals: targetedTotals,
    detail: targeted,
  },
};
const out = args.out ?? new URL(`../../../../docs/verification/logs-${report.ranAt.slice(0, 10)}.json`, import.meta.url).pathname;
mkdirSync(new URL(".", `file://${out}`).pathname, { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
console.log(`\n${report.verdict}. ${logsTotal} logs over ${blocksCovered} blocks (${(report.sample.shareOfIndexedBlocks * 100).toFixed(4)}% of the index). Written ${out}`);
console.log(JSON.stringify(totals));
console.log(`targeted: ${JSON.stringify(targetedTotals)}`);
await db.end();
process.exit(failures === 0 ? 0 : 1);
