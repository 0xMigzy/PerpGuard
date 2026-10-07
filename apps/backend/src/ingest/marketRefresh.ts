/**
 * THE MARKET LIST, RE-READ WHILE RUNNING (owner, 7 Oct 2026). Every risk
 * figure, and so every rescue trigger, rests on each market's maintenance
 * margin. It was read once at startup, so a market Perpl tightened mid-run
 * would have been assessed against the old requirement until a restart, and
 * found by a missed rescue instead of in the log.
 *
 * `applyMarketRefresh` is pure over the map it is given: it updates changed
 * markets IN PLACE (the loops hold this same map), adds new ones, and KEEPS a
 * market the venue no longer lists: a position on it is still open and still
 * monitored, and its rescue rule ends on the venue's own "not listed" answer,
 * not on a missing config. Every difference comes back as a line for the log.
 */
import type { MarketRiskConfig } from '@perpguard/shared';

export interface MarketChange {
  readonly marketId: number;
  readonly line: string;
  /** A maintenance-margin change is a WARNING: it moves every liquidation price on the market. */
  readonly severity: 'warn' | 'info';
}

const pctOf = (hdths: number): string => `${(100 / hdths * 100).toFixed(2)}%`;

export function applyMarketRefresh(current: Map<number, MarketRiskConfig>, fresh: ReadonlyMap<number, MarketRiskConfig>): MarketChange[] {
  const changes: MarketChange[] = [];
  for (const [id, next] of fresh) {
    const before = current.get(id);
    if (before === undefined) {
      current.set(id, next);
      changes.push({ marketId: id, severity: 'info', line: `market ${id} (${next.symbol}) is new in the venue's list: maintenance ${next.maintenanceMargin} (${pctOf(next.maintenanceMargin)})` });
      continue;
    }
    if (before.maintenanceMargin !== next.maintenanceMargin) {
      changes.push({
        marketId: id,
        severity: 'warn',
        line:
          `market ${id} (${next.symbol}) MAINTENANCE MARGIN CHANGED: ${before.maintenanceMargin} (${pctOf(before.maintenanceMargin)}) -> ` +
          `${next.maintenanceMargin} (${pctOf(next.maintenanceMargin)}); every liquidation price and distance on it moves from the next assessment`,
      });
    }
    for (const field of ['initialMargin', 'priceDecimals', 'lotDecimals', 'collateralDecimals', 'symbol'] as const) {
      if (before[field] !== next[field]) {
        changes.push({ marketId: id, severity: 'warn', line: `market ${id} (${next.symbol}) ${field} changed: ${String(before[field])} -> ${String(next[field])}` });
      }
    }
    if (changes.some((c) => c.marketId === id)) current.set(id, next);
  }
  for (const [id, before] of current) {
    if (!fresh.has(id)) {
      changes.push({ marketId: id, severity: 'warn', line: `market ${id} (${before.symbol}) is no longer in the venue's list; kept for monitoring, actions on it are refused by id` });
    }
  }
  return changes;
}
