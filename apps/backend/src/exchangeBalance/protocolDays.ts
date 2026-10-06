import { readFile, stat } from 'node:fs/promises';
import type { ProtocolTreasuryDays } from '@perpguard/shared';

/**
 * The protocol treasury's AUSD in and out of the Exchange, per UTC day, from
 * the scan `pnpm protocol:flows` writes (fixtures/protocol-flows-mainnet.json).
 * The index does not handle these events and adding them would force a full
 * re-sync, so the scan's output is the source. Only ProtocolBalanceDeposit and
 * ProtocolBalanceWithdraw cross the contract's edge; every other treasury event
 * moves money inside it and leaves the balance where it was.
 */
interface ScanFile {
  readonly scannedThroughBlock: number;
  readonly logs: readonly { readonly event: string; readonly block: number; readonly timestampMs: number; readonly args: Readonly<Record<string, string | boolean>> }[];
}

const DAY_MS = 86_400_000;

/** Pure: the scan's logs -> treasury in/out per UTC day, oldest first. */
export function protocolDaysOf(scan: ScanFile, collateralDecimals = 6): ProtocolTreasuryDays {
  const byDay = new Map<number, { inCns: bigint; outCns: bigint }>();
  let lastMs = 0;
  const movements: { atMs: number; ausd: number }[] = [];
  const scale = 10 ** collateralDecimals;
  for (const log of scan.logs) {
    if (log.event !== 'ProtocolBalanceDeposit' && log.event !== 'ProtocolBalanceWithdraw') continue;
    const dayMs = Math.floor(log.timestampMs / DAY_MS) * DAY_MS;
    const d = byDay.get(dayMs) ?? { inCns: 0n, outCns: 0n };
    const amount = BigInt(String(log.args['amountCNS']));
    if (log.event === 'ProtocolBalanceDeposit') d.inCns += amount;
    else d.outCns += amount;
    movements.push({ atMs: log.timestampMs, ausd: (log.event === 'ProtocolBalanceDeposit' ? 1 : -1) * (Number(amount) / scale) });
    byDay.set(dayMs, d);
    lastMs = Math.max(lastMs, log.timestampMs);
  }
  return {
    throughBlock: scan.scannedThroughBlock,
    days: [...byDay.entries()]
      .sort(([a], [b]) => a - b)
      .map(([dayMs, d]) => ({ dayMs, inAusd: Number(d.inCns) / scale, outAusd: Number(d.outCns) / scale })),
    movements: movements.sort((a, b) => a.atMs - b.atMs),
    lastEventAtMs: lastMs === 0 ? undefined : lastMs,
  };
}

/** Reads the scan's file, re-reading only when it changes on disk. */
export function protocolDaysFromFile(path: string): () => Promise<ProtocolTreasuryDays> {
  let cached: { mtimeMs: number; value: ProtocolTreasuryDays } | undefined;
  return async () => {
    const { mtimeMs } = await stat(path);
    if (cached?.mtimeMs === mtimeMs) return cached.value;
    const value = protocolDaysOf(JSON.parse(await readFile(path, 'utf8')) as ScanFile);
    cached = { mtimeMs, value };
    return value;
  };
}
