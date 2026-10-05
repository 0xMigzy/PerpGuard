/**
 * Computed insights for a wallet: FIXED RULES over indexed facts. No model, no
 * API call, no generated prose. Every sentence states the numbers it comes
 * from, describes what happened, and never guesses at intent or the future.
 * A rule with nothing to say is silent, and the whole panel is silent under
 * the same round-trip floor as the win rate.
 *
 * Pure: no I/O, no React. Unit tested.
 */
import type { LeverageBaseline, MarketRef, WalletInsightFacts } from '@perpguard/shared';
import { formatAusd, formatCompact, formatCount, formatPct } from './format.ts';
import { marketName } from './markets.ts';

export type InsightKey = 'rescuable' | 'leverage' | 'hold' | 'markets' | 'direction' | 'sizing';

export interface Insight {
  readonly key: InsightKey;
  /** A short label for the row. */
  readonly label: string;
  /** The sentence, with its numbers. */
  readonly text: string;
  /** Where the numbers come from, or their denominator. */
  readonly detail: string;
  /** `danger` only for the thesis rule when it fires. */
  readonly tone: 'danger' | 'neutral';
}

export type InsightsResult =
  | { readonly kind: 'silent'; readonly roundTrips: number; readonly floor: number }
  | { readonly kind: 'ok'; readonly insights: readonly Insight[] };

export interface InsightInputs {
  readonly facts: WalletInsightFacts;
  readonly baseline: LeverageBaseline | undefined;
  /** The ratio floor the page already uses for win rate. */
  readonly floor: number;
  /** The profile's liquidation counts: the SAME rescuable test as the Liquidations page. */
  readonly rescues: { readonly count: number; readonly judgeableCount: number; readonly rescuableCount: number };
  readonly bestMarket: { readonly market: MarketRef; readonly netPnlAusd: number; readonly roundTrips: number } | undefined;
  readonly worstMarket: { readonly market: MarketRef; readonly netPnlAusd: number; readonly roundTrips: number } | undefined;
  /** Open positions as the page priced them; notional undefined when unpriced. */
  readonly openPositions: readonly { readonly market: MarketRef; readonly side: 'long' | 'short'; readonly notionalAusd: number | undefined }[];
  /** The account summary's equity, undefined while any position is unpriced. */
  readonly equityAusd: number | undefined;
}

const money = (ausd: number): string => (Math.abs(ausd) >= 10_000 ? formatCompact(Math.abs(ausd)) : formatAusd(Math.abs(ausd), 0));
const multiple = (x: number): string => `${x.toFixed(1)}×`;
const times = (n: number): string => (n === 1 ? 'once' : `${formatCount(n)} times`);
/** A share that is not zero never prints as 0.0%: 2 of 824,883 is "under 0.1%". */
const share = (part: number, whole: number): string => (part > 0 && part / whole < 0.0005 ? 'under 0.1%' : formatPct(part / whole));
const capitalise = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
const madeOrLost = (ausd: number): string => (ausd > 0 ? `made ${money(ausd)}` : ausd < 0 ? `lost ${money(ausd)}` : 'broke even');

export function walletInsights(input: InsightInputs): InsightsResult {
  const { facts, floor } = input;
  if (facts.roundTrips < floor) return { kind: 'silent', roundTrips: facts.roundTrips, floor };
  const out: Insight[] = [];

  // 1. THE THESIS, per wallet: liquidated while the free balance covered the shortfall.
  const r = input.rescues;
  if (r.count > 0 && r.judgeableCount > 0) {
    out.push(
      r.rescuableCount > 0
        ? {
            key: 'rescuable',
            label: 'Liquidated with spare AUSD',
            text: `Liquidated ${times(r.rescuableCount)} while holding enough free AUSD to prevent it.`,
            detail: `${formatCount(r.rescuableCount)} of ${formatCount(r.judgeableCount)} liquidations: the free balance covered the top-up that would have kept the position open, the same test as the Liquidations page.`,
            tone: 'danger',
          }
        : {
            key: 'rescuable',
            label: 'Liquidations',
            text: `Liquidated ${times(r.count)}, never while holding enough free AUSD to prevent it.`,
            detail: `0 of ${formatCount(r.judgeableCount)} liquidations were rescuable from the free balance.`,
            tone: 'neutral',
          },
    );
  }

  // 2. Leverage against the median account.
  const median = input.baseline?.medianLeverage;
  if (facts.averageLeverage !== undefined && median !== undefined && median > 0 && input.baseline !== undefined) {
    out.push({
      key: 'leverage',
      label: 'Leverage',
      text: `${multiple(facts.averageLeverage)} average leverage at open, ${multiple(facts.averageLeverage / median)} the median trader's ${multiple(median)}.`,
      detail: `Mean over ${formatCount(facts.roundTrips)} round trips; the median is across ${formatCount(input.baseline.accounts)} accounts with ${formatCount(input.baseline.minRoundTrips)}+ round trips.`,
      tone: 'neutral',
    });
  }

  // 3. Hold time against outcome.
  if (facts.losingTrips > 0) {
    const h = facts.holdThresholdHours;
    out.push({
      key: 'hold',
      label: 'Hold time',
      text:
        facts.losingTripsHeldOver === 0
          ? `None of the ${formatCount(facts.losingTrips)} losing round trips was held over ${h} hours.`
          : `${capitalise(share(facts.losingTripsHeldOver, facts.losingTrips))} of losing round trips were held over ${h} hours.`,
      detail: `${formatCount(facts.losingTripsHeldOver)} of ${formatCount(facts.losingTrips)} losses; ${formatCount(facts.tripsHeldOver)} of all ${formatCount(facts.roundTrips)} round trips were held that long.`,
      tone: 'neutral',
    });
  }

  // 4. Best and worst market by net PnL.
  const best = input.bestMarket;
  const worst = input.worstMarket;
  if (best !== undefined && worst !== undefined && best.market.marketId !== worst.market.marketId) {
    const sign = (x: number) => (x > 0 ? '+' : x < 0 ? '−' : '');
    out.push({
      key: 'markets',
      label: 'Markets',
      // "Best" is the highest net PnL, so when it is negative EVERY market lost,
      // and when the worst is positive every market made money: say that, not
      // "best market (−9)".
      text:
        best.netPnlAusd < 0
          ? `Lost on every market traded: least on ${marketName(best.market)} (${sign(best.netPnlAusd)}${money(best.netPnlAusd)}), most on ${marketName(worst.market)} (${sign(worst.netPnlAusd)}${money(worst.netPnlAusd)}).`
          : worst.netPnlAusd > 0
            ? `Made money on every market traded: most on ${marketName(best.market)} (${sign(best.netPnlAusd)}${money(best.netPnlAusd)}), least on ${marketName(worst.market)} (${sign(worst.netPnlAusd)}${money(worst.netPnlAusd)}).`
            : `Best market ${marketName(best.market)} (${sign(best.netPnlAusd)}${money(best.netPnlAusd)}), worst ${marketName(worst.market)} (${sign(worst.netPnlAusd)}${money(worst.netPnlAusd)}).`,
      detail: `Net PnL (realised + funding − fees) over ${formatCount(best.roundTrips)} and ${formatCount(worst.roundTrips)} round trips. AUSD.`,
      tone: 'neutral',
    });
  }

  // 5. Direction: how the round trips split, and which side holds the losses.
  const sided = facts.longTrips + facts.shortTrips;
  if (sided > 0) {
    out.push({
      key: 'direction',
      label: 'Direction',
      text: `${formatPct(facts.longTrips / sided)} of round trips were long. Longs ${madeOrLost(facts.longNetPnlAusd)}, shorts ${madeOrLost(facts.shortNetPnlAusd)}.`,
      detail: `${formatCount(facts.longTrips)} long and ${formatCount(facts.shortTrips)} short round trips; net PnL per side, AUSD.`,
      tone: 'neutral',
    });
  }

  // 6. Sizing: the largest open position against the account's equity, now.
  const priced = input.openPositions.filter((p) => p.notionalAusd !== undefined && p.notionalAusd > 0);
  if (priced.length > 0 && input.equityAusd !== undefined && input.equityAusd > 0) {
    const largest = priced.reduce((a, b) => (b.notionalAusd! > a.notionalAusd! ? b : a));
    out.push({
      key: 'sizing',
      label: 'Position size',
      text: `Largest open position: ${marketName(largest.market)} ${largest.side}, ${money(largest.notionalAusd!)} notional, ${multiple(largest.notionalAusd! / input.equityAusd)} equity.`,
      detail: `Equity ${money(input.equityAusd)} AUSD (free + margin + unrealised), now; notional at the venue's mark.`,
      tone: 'neutral',
    });
  }

  return { kind: 'ok', insights: out };
}
