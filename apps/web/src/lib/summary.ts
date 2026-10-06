/**
 * The one-sentence summaries at the top of the Overview and the Risk page,
 * from data each page already loads. Pure.
 *
 * The risk clause keeps the page's rules: ONE direction per figure (a fall
 * closes longs, and only longs), and insurance judged PER MARKET against that
 * market's own losses beyond collateral, never pooled into one ratio. "Fully
 * covered" is said only when every market with such losses holds a fund that
 * covers them.
 */
import type { MarketExposure, RiskSnapshot, Timeframe } from '@perpguard/shared';
import { formatCount, formatMoney, formatSignedPct } from './format.ts';
import { marketName } from './markets.ts';

const WINDOW_WORDS: Readonly<Record<Exclude<Timeframe, 'all'>, string>> = { '24h': '24-hour', '7d': '7-day', '30d': '30-day' };

export interface ActivityInputs {
  readonly timeframe: Timeframe;
  /** "Feb 11, 2026", for All. */
  readonly sinceLabel: string | undefined;
  readonly volumeAusd: number;
  /** Change against the previous window, as a fraction; undefined when there is none to compare. */
  readonly volumeChange: number | undefined;
  readonly traders: number;
  readonly netFlowAusd: number;
}

/** "30-day volume $1.43B (−38%), 1,069 traders, $167K net outflow." */
export function activitySentence(a: ActivityInputs): string {
  const change = a.volumeChange === undefined ? '' : ` (${formatSignedPct(a.volumeChange, 0)})`;
  const flow =
    a.netFlowAusd > 0 ? `${formatMoney(a.netFlowAusd)} net inflow` : a.netFlowAusd < 0 ? `${formatMoney(Math.abs(a.netFlowAusd))} net outflow` : 'no net flow';
  const lead = a.timeframe === 'all' ? `Since ${a.sinceLabel ?? 'launch'}, volume` : `${WINDOW_WORDS[a.timeframe]} volume`;
  return `${lead} ${formatMoney(a.volumeAusd)}${change}, ${formatCount(a.traders)} trader${a.traders === 1 ? '' : 's'}, ${flow}.`;
}

const TEN = '0.100';

/**
 * "A 10% fall would liquidate $334K of longs, fully covered by each market's
 * own insurance fund." Undefined while the snapshot has no 10% rung.
 */
export function riskSentence(s: Pick<RiskSnapshot, 'atRisk' | 'markets'>): string | undefined {
  const fall = s.atRisk[TEN]?.fall;
  if (fall === undefined) return undefined;
  if (fall.positions === 0) return 'A 10% fall would liquidate no longs.';
  const head = `A 10% fall would liquidate ${formatMoney(fall.notionalAusd)} of longs`;
  // Per market: its own losses beyond collateral at a 10% fall, against its own fund.
  const exposed = s.markets
    .map((m: MarketExposure) => ({ m, shortfall: m.atRisk[TEN]?.fall.shortfallAusd ?? 0 }))
    .filter((x) => x.shortfall > 0.005);
  if (exposed.length === 0) return `${head}; none would lose more than its own collateral.`;
  const unknown = exposed.filter((x) => x.m.insuranceAusd === undefined);
  const short = exposed
    .filter((x) => x.m.insuranceAusd !== undefined && x.m.insuranceAusd < x.shortfall)
    .sort((a, b) => b.shortfall - (b.m.insuranceAusd ?? 0) - (a.shortfall - (a.m.insuranceAusd ?? 0)));
  if (short.length > 0) {
    const w = short[0]!;
    const more = short.length > 1 ? ` (and ${formatCount(short.length - 1)} more market${short.length === 2 ? '' : 's'})` : '';
    return `${head}; on ${marketName(w.m.market)} the losses beyond collateral (${formatMoney(w.shortfall)}) exceed its insurance fund (${formatMoney(w.m.insuranceAusd!)})${more}.`;
  }
  if (unknown.length > 0) {
    return `${head}; ${formatCount(unknown.length)} market${unknown.length === 1 ? '' : 's'} with losses beyond collateral ${unknown.length === 1 ? 'has' : 'have'} no insurance reading.`;
  }
  return `${head}, fully covered by each market's own insurance fund.`;
}
