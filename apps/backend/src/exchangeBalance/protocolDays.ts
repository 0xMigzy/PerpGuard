import { readFile } from 'node:fs/promises';
import type { ProtocolTreasuryDays, TreasuryMovement, TreasuryScanStatus } from '@perpguard/shared';

/**
 * The protocol treasury's AUSD in and out of the Exchange, per UTC day, from
 * the movements the incremental scan keeps (`treasuryScanner.ts`). Only
 * ProtocolBalanceDeposit and ProtocolBalanceWithdraw cross the contract's
 * edge; every other treasury event moves money inside it.
 */
const DAY_MS = 86_400_000;

/** Pure: movements + the scan's status -> what the route serves. */
export function treasuryDaysOf(movements: readonly TreasuryMovement[], scan: TreasuryScanStatus, collateralDecimals = 6): ProtocolTreasuryDays {
  const scale = 10 ** collateralDecimals;
  const byDay = new Map<number, { inCns: bigint; outCns: bigint }>();
  for (const m of movements) {
    const dayMs = Math.floor(m.atMs / DAY_MS) * DAY_MS;
    const d = byDay.get(dayMs) ?? { inCns: 0n, outCns: 0n };
    if (m.direction === 'in') d.inCns += m.amountCNS;
    else d.outCns += m.amountCNS;
    byDay.set(dayMs, d);
  }
  const sorted = [...movements].sort((a, b) => a.atMs - b.atMs);
  return {
    throughBlock: scan.throughBlock ?? 0,
    days: [...byDay.entries()]
      .sort(([a], [b]) => a - b)
      .map(([dayMs, d]) => ({ dayMs, inAusd: Number(d.inCns) / scale, outAusd: Number(d.outCns) / scale })),
    movements: sorted.map((m) => ({ atMs: m.atMs, ausd: (m.direction === 'in' ? 1 : -1) * (Number(m.amountCNS) / scale) })),
    lastEventAtMs: sorted.at(-1)?.atMs,
    scan,
  };
}

interface ScanFile {
  readonly scannedThroughBlock: number;
  readonly logs: readonly { readonly event: string; readonly block: number; readonly timestampMs: number; readonly txHash: string; readonly logIndex: number; readonly args: Readonly<Record<string, string | boolean>> }[];
}

/** The committed one-off scan (`pnpm protocol:flows`) as movements and its cursor: the store's seed. */
export function movementsFromScanFile(scan: ScanFile): { readonly throughBlock: number; readonly movements: readonly TreasuryMovement[] } {
  const movements = scan.logs
    .filter((l) => l.event === 'ProtocolBalanceDeposit' || l.event === 'ProtocolBalanceWithdraw')
    .map((l): TreasuryMovement => ({
      block: l.block,
      txHash: l.txHash.toLowerCase(),
      logIndex: l.logIndex,
      atMs: l.timestampMs,
      direction: l.event === 'ProtocolBalanceDeposit' ? 'in' : 'out',
      amountCNS: BigInt(String(l.args['amountCNS'])),
    }));
  return { throughBlock: scan.scannedThroughBlock, movements };
}

export async function readScanFile(path: string): Promise<ReturnType<typeof movementsFromScanFile>> {
  return movementsFromScanFile(JSON.parse(await readFile(path, 'utf8')) as ScanFile);
}
