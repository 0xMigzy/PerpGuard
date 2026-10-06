/**
 * Every protocol-treasury event the Exchange has emitted, read straight off the
 * chain, for rebuilding the exchange's AUSD balance over time.
 *
 *   pnpm protocol:flows                 # deployment block -> head, resumable
 *   pnpm protocol:flows --concurrency 4
 *
 * The index does not handle these events (docs/EVENTS.md marks them "later"),
 * and adding handlers would force a full re-sync of perpguard_full. They are
 * rare, so this scans `eth_getLogs` on the Exchange PROXY (the only emitter),
 * filtered to their nine topics, in pages the RPC accepts (1,000 blocks: wider
 * is refused with HTTP 413), and writes every log decoded with the saved ABI to
 * `fixtures/protocol-flows-mainnet.json`.
 *
 * EXCEPT `RecycleFeeToProtocol`, which fires per order (over a thousand in the
 * first 3M blocks) and moves money INSIDE the contract, so it cannot change the
 * contract's balance. It is kept as a running count and total rather than one
 * row per log, and needs no block timestamp.
 *
 * Progress is saved as it goes, so an interrupted run resumes from its last
 * contiguous page instead of starting again. Read-only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { decodeEventLog, toEventSelector, type Abi, type AbiEvent, type Hex } from "viem";

const DEPLOY_BLOCK = 54_773_010;
const PROXY = "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F";
const PAGE = 1_000;
const OUT = new URL("../../../../fixtures/protocol-flows-mainnet.json", import.meta.url);

/** The nine events that move money between the protocol treasury and anything else. */
const EVENTS = [
  "ProtocolBalanceDeposit",
  "ProtocolBalanceWithdraw",
  "TransferAccountToProtocol",
  "TransferProtocolToAccount",
  "TransferPerpInsToProtocol",
  "TransferPerpPosToProtocol",
  "TransferProtocolToPerp",
  "TransferProtocolToRecycleBal",
  "RecycleFeeToProtocol",
] as const;

const { values: args } = parseArgs({ options: { concurrency: { type: "string", default: "6" }, to: { type: "string" } } });
const CONCURRENCY = Number(args.concurrency);

const rpcUrl = process.env.PERPL_MAINNET_RPC_URL?.trim() || process.env.ENVIO_PERPL_RPC_URL?.trim() || "https://rpc.monad.xyz";
const abiFile = JSON.parse(readFileSync(new URL("../../abis/Exchange.json", import.meta.url), "utf8"));
const abi = (abiFile.abi ?? abiFile) as Abi;
const wanted = (abi.filter((i) => i.type === "event") as AbiEvent[]).filter((e) => (EVENTS as readonly string[]).includes(e.name));
if (wanted.length !== EVENTS.length) throw new Error(`ABI is missing some of: ${EVENTS.join(", ")}`);
const TOPICS = wanted.map((e) => toEventSelector(e));

interface RpcLog {
  readonly blockNumber: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface ProtocolFlowLog {
  readonly event: (typeof EVENTS)[number];
  readonly block: number;
  readonly timestampMs: number;
  readonly txHash: string;
  readonly logIndex: number;
  /** Decoded arguments; every uint256 as a decimal string. */
  readonly args: Readonly<Record<string, string | boolean>>;
}

interface Output {
  readonly note: string;
  /** `RecycleFeeToProtocol`, folded: internal to the contract. */
  recycleFeeToProtocol: { count: number; totalCNS: string };
  readonly exchange: string;
  readonly fromBlock: number;
  /** Every block up to and including this one has been scanned. */
  scannedThroughBlock: number;
  logs: ProtocolFlowLog[];
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json()) as { result?: T; error?: { message: string } };
      if (body.result !== undefined) return body.result;
      if (attempt >= 6) throw new Error(`${method}: ${body.error?.message ?? response.status}`);
    } catch (error) {
      if (attempt >= 6) throw error;
    }
    await new Promise((r) => setTimeout(r, 1_000 * attempt));
  }
}

const hex = (n: number) => `0x${n.toString(16)}`;

async function page(from: number, to: number): Promise<RpcLog[]> {
  return rpc<RpcLog[]>("eth_getLogs", [{ address: PROXY, topics: [TOPICS], fromBlock: hex(from), toBlock: hex(to) }]);
}

/**
 * A block's time, INTERPOLATED from the index rather than asked of the RPC one
 * block at a time: every funding settlement the index holds is a known
 * (block, time) pair, about every 43 minutes since launch, so the time between
 * two of them is accurate to seconds. Only the UTC day is used downstream.
 * Past the last settlement it extrapolates at the recent block rate.
 */
const anchors: { block: number; ms: number }[] = await (async () => {
  const dbUrl = process.env.INDEXER_DATABASE_URL;
  if (dbUrl === undefined) throw new Error("INDEXER_DATABASE_URL is not set: block times come from the index");
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const { rows } = await db.query<{ block: string; ms: string }>(
    `select "blockNumber"::text as block, (extract(epoch from min(timestamp)) * 1000)::bigint::text as ms
       from "FundingEvent" group by "blockNumber" order by "blockNumber"`,
  );
  await db.end();
  return rows.map((r) => ({ block: Number(r.block), ms: Number(r.ms) }));
})();
if (anchors.length < 2) throw new Error("the index holds fewer than two funding settlements to interpolate block times from");

function blockTimeMs(block: number): number {
  let hi = anchors.findIndex((a) => a.block >= block);
  if (hi === -1) hi = anchors.length - 1;
  if (hi === 0) hi = 1;
  const a = anchors[hi - 1]!;
  const b = anchors[hi]!;
  return Math.round(a.ms + ((block - a.block) * (b.ms - a.ms)) / (b.block - a.block));
}

async function decode(log: RpcLog): Promise<ProtocolFlowLog> {
  const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  const block = Number(BigInt(log.blockNumber));
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(decoded.args as Record<string, unknown>)) out[k] = typeof v === "boolean" ? v : String(v);
  return {
    event: decoded.eventName as ProtocolFlowLog["event"],
    block,
    timestampMs: blockTimeMs(block),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex)),
    args: out,
  };
}

const head = args.to !== undefined ? Number(args.to) : Number(BigInt(await rpc<Hex>("eth_blockNumber", [])));
const state: Output = existsSync(OUT)
  ? (JSON.parse(readFileSync(OUT, "utf8")) as Output)
  : {
      note: "Protocol-treasury events off the Exchange proxy, from eth_getLogs. Written by apps/indexer/src/scripts/protocol-flows.ts; resumable. Timestamps are interpolated from the index's funding settlements (accurate to seconds; only the UTC day is used).",
      exchange: PROXY,
      fromBlock: DEPLOY_BLOCK,
      scannedThroughBlock: DEPLOY_BLOCK - 1,
      recycleFeeToProtocol: { count: 0, totalCNS: "0" },
      logs: [],
    };
// A file from before recycle fees were folded: fold the ones it holds.
state.recycleFeeToProtocol ??= { count: 0, totalCNS: "0" };
for (const l of state.logs.filter((x) => x.event === "RecycleFeeToProtocol")) {
  state.recycleFeeToProtocol.count += 1;
  state.recycleFeeToProtocol.totalCNS = (BigInt(state.recycleFeeToProtocol.totalCNS) + BigInt(String(l.args.recycleFeeCNS))).toString();
}
state.logs = state.logs.filter((x) => x.event !== "RecycleFeeToProtocol");
const RECYCLE_TOPIC = toEventSelector(wanted.find((e) => e.name === "RecycleFeeToProtocol")!).toLowerCase();

const save = () => {
  state.logs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  writeFileSync(OUT, `${JSON.stringify(state, null, 1)}\n`);
};

const started = Date.now();
let next = state.scannedThroughBlock + 1;
const total = head - next + 1;
console.log(`scanning ${next.toLocaleString()} -> ${head.toLocaleString()} (${Math.ceil(total / PAGE).toLocaleString()} pages, ${CONCURRENCY} at a time)`);

while (next <= head) {
  // One batch of pages, in order, so "scanned through" only ever moves past a contiguous run.
  const batch: [number, number][] = [];
  for (let i = 0; i < CONCURRENCY * 10 && next <= head; i += 1) {
    const to = Math.min(next + PAGE - 1, head);
    batch.push([next, to]);
    next = to + 1;
  }
  const results: RpcLog[][] = new Array(batch.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < batch.length) {
        const i = cursor++;
        results[i] = await page(batch[i]![0], batch[i]![1]);
      }
    }),
  );
  for (const logs of results)
    for (const log of logs) {
      if (log.topics[0]?.toLowerCase() === RECYCLE_TOPIC) {
        const { args: a } = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as { args: { recycleFeeCNS: bigint } };
        state.recycleFeeToProtocol.count += 1;
        state.recycleFeeToProtocol.totalCNS = (BigInt(state.recycleFeeToProtocol.totalCNS) + a.recycleFeeCNS).toString();
      } else state.logs.push(await decode(log));
    }
  state.scannedThroughBlock = batch[batch.length - 1]![1];
  save();
  const done = state.scannedThroughBlock - DEPLOY_BLOCK + 1;
  const all = head - DEPLOY_BLOCK + 1;
  process.stdout.write(`\r${((done / all) * 100).toFixed(1)}%  block ${state.scannedThroughBlock.toLocaleString()}  ${state.logs.length} logs + ${state.recycleFeeToProtocol.count} recycle fees  ${Math.round((Date.now() - started) / 1000)} s   `);
}
console.log(`\ndone: ${state.logs.length} logs through block ${state.scannedThroughBlock.toLocaleString()}`);
const counts = new Map<string, number>();
for (const l of state.logs) counts.set(l.event, (counts.get(l.event) ?? 0) + 1);
for (const e of EVENTS) console.log(`  ${e}: ${e === "RecycleFeeToProtocol" ? state.recycleFeeToProtocol.count : (counts.get(e) ?? 0)}`);
