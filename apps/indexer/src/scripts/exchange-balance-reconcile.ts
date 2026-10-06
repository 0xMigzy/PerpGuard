/**
 * Does the exchange's AUSD balance rebuild from events?
 *
 *   pnpm exchange:reconcile
 *
 * At ONE block B (the last block `pnpm protocol:flows` scanned, or the index's
 * latest processed block if that is earlier):
 *
 *   rebuilt  = indexed deposits − indexed withdrawals          (CollateralFlow)
 *            + ProtocolBalanceDeposit − ProtocolBalanceWithdraw  (treasury in/out)
 *   contract = AUSD.balanceOf(Exchange) at B                     (eth_call)
 *
 * Everything else the treasury does (to and from accounts, perps, the recycle
 * balance) moves money INSIDE the contract and cannot change its balance; their
 * totals are reported beside the result so that assumption is visible, not
 * buried. Writes `fixtures/exchange-balance-reconciliation.json`. Read-only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";

const PROXY = "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F";
const OUT = new URL("../../../../fixtures/exchange-balance-reconciliation.json", import.meta.url);
const FLOWS = new URL("../../../../fixtures/protocol-flows-mainnet.json", import.meta.url);

const rpcUrl = process.env.PERPL_MAINNET_RPC_URL?.trim() || process.env.ENVIO_PERPL_RPC_URL?.trim() || "https://rpc.monad.xyz";
const dbUrl = process.env.INDEXER_DATABASE_URL;
if (dbUrl === undefined) throw new Error("INDEXER_DATABASE_URL is not set");

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? response.status}`);
  return body.result;
}

interface Flows {
  scannedThroughBlock: number;
  logs: { event: string; block: number; timestampMs: number; args: Record<string, string | boolean> }[];
  recycleFeeToProtocol: { count: number; totalCNS: string };
}
const flows = JSON.parse(readFileSync(FLOWS, "utf8")) as Flows;

const db = new Client({ connectionString: dbUrl });
await db.connect();
const meta = await db.query<{ block: string; token: string }>(`select (select latest_processed_block::text from chain_metadata limit 1) as block, (select "collateralToken" from "Exchange" limit 1) as token`);
const indexedThrough = Number(meta.rows[0]!.block);
const token = meta.rows[0]!.token;
const B = Math.min(flows.scannedThroughBlock, indexedThrough);

const cf = await db.query<{ deposited: string; withdrawn: string }>(
  `select coalesce(sum("amountCNS") filter (where kind = 'DEPOSIT'), 0)::text as deposited,
          coalesce(sum("amountCNS") filter (where kind = 'WITHDRAWAL'), 0)::text as withdrawn
     from "CollateralFlow" where "blockNumber" <= $1`,
  [B],
);
await db.end();

const sum = (event: string, field: string) => flows.logs.filter((l) => l.event === event && l.block <= B).reduce((s, l) => s + BigInt(String(l.args[field])), 0n);
const deposited = BigInt(cf.rows[0]!.deposited);
const withdrawn = BigInt(cf.rows[0]!.withdrawn);
const protocolIn = sum("ProtocolBalanceDeposit", "amountCNS");
const protocolOut = sum("ProtocolBalanceWithdraw", "amountCNS");
const rebuilt = deposited - withdrawn + protocolIn - protocolOut;

// balanceOf(address) at block B.
const data = `0x70a08231${PROXY.slice(2).toLowerCase().padStart(64, "0")}`;
const contract = BigInt(await rpc<string>("eth_call", [{ to: token, data }, `0x${B.toString(16)}`]));
const gap = contract - rebuilt;

const ausd = (cns: bigint) => Number(cns) / 1e6;
const internal = {
  TransferProtocolToAccount: ausd(sum("TransferProtocolToAccount", "amountCNS")),
  TransferAccountToProtocol: ausd(sum("TransferAccountToProtocol", "amountCNS")),
  TransferProtocolToPerp: ausd(sum("TransferProtocolToPerp", "amountCNS")),
  TransferPerpInsToProtocol: ausd(sum("TransferPerpInsToProtocol", "amountCNS")),
  TransferPerpPosToProtocol: ausd(sum("TransferPerpPosToProtocol", "amountCNS")),
  TransferProtocolToRecycleBal: ausd(sum("TransferProtocolToRecycleBal", "amountCNS")),
  RecycleFeeToProtocol: ausd(BigInt(flows.recycleFeeToProtocol.totalCNS)),
};
const result = {
  note: "Written by apps/indexer/src/scripts/exchange-balance-reconcile.ts. All figures AUSD at one block.",
  atBlock: B,
  collateralDeposited: ausd(deposited),
  collateralWithdrawn: ausd(withdrawn),
  protocolBalanceDeposit: ausd(protocolIn),
  protocolBalanceWithdraw: ausd(protocolOut),
  rebuilt: ausd(rebuilt),
  contractBalance: ausd(contract),
  gap: ausd(gap),
  gapCNS: gap.toString(),
  internalMovementsNotCounted: internal,
};
writeFileSync(OUT, `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify(result, null, 1));
