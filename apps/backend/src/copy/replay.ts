/**
 * 🔁 COPY TRADING, HALF A: WHAT WOULD HAVE HAPPENED (owner, 7 Oct 2026).
 *
 * Replays one leader's last window onto an account of a given size, from
 * indexed data only. Nothing is sent anywhere: this is arithmetic over what
 * the index recorded. Pure, no I/O.
 *
 * THE RULES, each said on the page and in the bot:
 *   - ONLY NEW OPENS ARE COPIED. A position the leader already held when the
 *     window began is listed as skipped: a copy starts with the next open.
 *   - SIZE IS PROPORTIONAL TO THE ACCOUNT, 2% -> 2%. At each open, the copy is
 *     scaled by (the follower's equity) / (the leader's equity) at that moment.
 *     Equity is deposits minus withdrawals plus realised results, on both
 *     sides; unrealised P&L is not in it.
 *   - MARKETS ARE TRANSLATED BY CANONICAL TICKER, each network's own context
 *     naming its own markets (never the indexer's name). A ticker the acting
 *     network does not list is skipped, by name.
 *   - THE COPY'S SIZE IS ROUNDED DOWN to the acting market's size step; a copy
 *     that rounds to nothing is skipped as too small.
 *   - THE MARGIN IT NEEDS is the leader's PEAK margin, scaled and rounded UP:
 *     the index keeps a position's open and close but not the adds between,
 *     so the peak is the conservative figure. A copy whose margin the
 *     follower's free balance cannot cover at that moment is skipped.
 *   - A LEVERAGE ABOVE THE ACTING MARKET'S MAXIMUM is skipped.
 *   - THE RESULT is the leader's lifetime result on that position times the
 *     copy's scale (exact for a proportional copy of every fill at the
 *     leader's prices), ROUNDED AGAINST THE READER: a loss away from zero, a
 *     gain toward it (integer floor does both). Funding and forced exits scale
 *     with it. A position still open is valued at the current mark and marked
 *     as an estimate.
 *   - FEES ARE THE COPY'S OWN. The index keeps no fees per position (only per
 *     account per day), so the leader's result is BEFORE fees, and each copy is
 *     charged the acting market's TAKER fee on opening and on closing its full
 *     size at the entry price, rounded up. Adds and reduces in between are not
 *     in the index, so this is the least the copy would have paid. The
 *     leader's own daily fees come off the leader's equity, for the scale.
 *   - THE LEADER'S BOOKS ARE RECONCILED, AND A GAP IS SAID (owner, 7 Oct
 *     2026). Its equity walked to today by this file's own rule (start +
 *     deposits − withdrawals + results − fees, plus open positions' results so
 *     far) must meet the index's books (free balance + open margin) within
 *     1 AUSD or 0.1%. When it does not, the replay is marked NOT RECONCILED
 *     with the gap in AUSD: #4886 is 2,007.40 AUSD out with nothing indexed
 *     to explain it, and its every copy is scaled off that equity.
 *   - A LEADER TOO BUSY TO REPLAY (more opens than the cap) is refused whole,
 *     never replayed in part: a partial replay's totals would mislead.
 */
import type { CopySource, CopySourcePosition, Side } from '@perpguard/shared';
import { describeMarket } from '@perpguard/shared';

/** One market on the ACTING network, from its own context. */
export interface CopyMarket {
  readonly marketId: number;
  /** Canonical ticker, from the acting network's context. */
  readonly symbol: string;
  readonly sizeDecimals: number;
  readonly maxLeverage: number;
  /** The acting market's taker fee, in millionths: a copy trades at the market, so it pays the taker's rate. */
  readonly takerFeeMicros: number;
}

export interface ReplayInput {
  readonly source: CopySource;
  readonly followerEquityCNS: bigint;
  readonly actingNetwork: string;
  readonly actingMarkets: readonly CopyMarket[];
  /** The current mark on the LEADER's network, as a price (the venue serves it so). */
  readonly markOf: (marketId: number) => number | undefined;
  /** More opens than this and the replay is refused whole. */
  readonly cap: number;
}

export type SkipReason = 'open-at-start' | 'not-listed' | 'no-size' | 'no-entry' | 'too-small' | 'leverage' | 'no-balance' | 'leader-no-equity';

export interface ReplayCopy {
  readonly kind: 'copied';
  readonly actingMarketId: number;
  /** The copy's size in the acting market's units (`sizeDecimals`). */
  readonly sizeUnits: bigint;
  readonly sizeDecimals: number;
  readonly marginCNS: bigint;
  /** The copy's taker fee on opening and closing its full size, rounded up. Already in `resultCNS`. */
  readonly feeCNS: bigint;
  /** After the fee. Undefined only for an open position with no current mark. */
  readonly resultCNS: bigint | undefined;
  /** True for a position still open: valued at the current mark, not realised. */
  readonly estimate: boolean;
  /** The copy's size over the leader's peak size. */
  readonly scale: number;
}

export interface ReplaySkip {
  readonly kind: 'skipped';
  readonly reason: SkipReason;
  /** One plain sentence. */
  readonly text: string;
}

export interface ReplayTrade {
  readonly key: string;
  readonly symbol: string;
  readonly side: Side;
  readonly status: 'open' | 'closed' | 'forced';
  readonly openedAtMs: number;
  readonly closedAtMs: number | undefined;
  readonly leader: {
    readonly peakLotLNS: bigint;
    readonly lotDecimals: number;
    readonly peakMarginCNS: bigint;
    /** BEFORE FEES: the index keeps none per position. */
    readonly netPnlCNS: bigint;
    readonly leverage: number | undefined;
  };
  readonly copy: ReplayCopy | ReplaySkip;
}

export interface ReplayTotals {
  readonly copied: number;
  readonly skipped: number;
  readonly skippedBy: Readonly<Partial<Record<SkipReason, number>>>;
  /** Tickers skipped as not listed on the acting network, with how many each. */
  readonly notListed: readonly { readonly symbol: string; readonly count: number }[];
  readonly closedResultCNS: bigint;
  readonly openEstimateCNS: bigint;
  /** Every copy's fee, closed and open alike; already inside the two results above. */
  readonly feesCNS: bigint;
  /** Copies the leader's forced exits took with them. */
  readonly forcedExits: number;
  readonly wins: number;
  readonly losses: number;
  /** The leader's own result on the positions that were copied, BEFORE FEES, for comparison. */
  readonly leaderResultOnCopiedCNS: bigint;
  /** The follower's equity after the closed results; open estimates not in it. */
  readonly followerEndEquityCNS: bigint;
  /** The lowest the follower's free balance went, after margin committed. */
  readonly lowestFreeCNS: bigint;
}

export interface ReplayBooks {
  readonly rebuiltCNS: bigint;
  readonly indexCNS: bigint;
  /** Rebuilt minus the index's. */
  readonly gapCNS: bigint;
  readonly reconciled: boolean;
}

/** Within 1 AUSD or 0.1% of the larger side, whichever is wider. */
export function reconcile(rebuiltCNS: bigint, indexCNS: bigint, collateralDecimals: number): ReplayBooks {
  const gap = rebuiltCNS - indexCNS;
  const abs = gap < 0n ? -gap : gap;
  const larger = (rebuiltCNS > indexCNS ? rebuiltCNS : indexCNS);
  const tolerance = [10n ** BigInt(collateralDecimals), (larger < 0n ? -larger : larger) / 1_000n].reduce((a, b) => (a > b ? a : b));
  return { rebuiltCNS, indexCNS, gapCNS: gap, reconciled: abs <= tolerance };
}

export type ReplayResult =
  | {
      readonly kind: 'replayed';
      readonly accountId: number;
      readonly fromMs: number;
      readonly toMs: number;
      readonly actingNetwork: string;
      readonly collateralDecimals: number;
      readonly followerStartCNS: bigint;
      readonly leaderStartCNS: bigint;
      readonly trades: readonly ReplayTrade[];
      readonly totals: ReplayTotals;
      /** The leader's equity rebuilt to today against the index's own books. */
      readonly books: ReplayBooks;
      /** The follower's equity after each copy closed, oldest first, starting at the window's start. */
      readonly curve: readonly { readonly atMs: number; readonly equityCNS: bigint }[];
    }
  | { readonly kind: 'too-busy'; readonly accountId: number; readonly openedInWindow: number; readonly cap: number; readonly fromMs: number; readonly toMs: number }
  | { readonly kind: 'no-follower-equity'; readonly accountId: number };

const pow10 = (n: number): bigint => 10n ** BigInt(n);
/** Integer division rounded toward minus infinity: a loss away from zero, a gain toward it. */
const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
};
const ceilDiv = (a: bigint, b: bigint): bigint => -floorDiv(-a, b);

/** The leader's leverage on this position: notional at entry over peak margin, else the index's own figure. */
function leverageOf(p: CopySourcePosition, collateralDecimals: number): number | undefined {
  if (p.entryPricePNS !== undefined && p.peakMarginCNS > 0n && p.peakLotLNS > 0n) {
    const notionalCNS = (p.peakLotLNS * p.entryPricePNS * pow10(collateralDecimals)) / pow10(p.lotDecimals + p.priceDecimals);
    return Number((notionalCNS * 100n) / p.peakMarginCNS) / 100;
  }
  return p.leverageHdths > 0n ? Number(p.leverageHdths) / 100 : undefined;
}

/** The leader's result on a still-open position: realised so far plus the move at the current mark. */
function openResultCNS(p: CopySourcePosition, markPrice: number | undefined, collateralDecimals: number): bigint | undefined {
  if (markPrice === undefined || !Number.isFinite(markPrice) || p.entryPricePNS === undefined) return undefined;
  const mark = BigInt(Math.round(markPrice * 10 ** p.priceDecimals));
  const sign = p.side === 'long' ? 1n : -1n;
  const move = floorDiv(sign * (mark - p.entryPricePNS) * p.lotLNS * pow10(collateralDecimals), pow10(p.priceDecimals + p.lotDecimals));
  return p.netPnlCNS + move;
}

/**
 * AUSD to the cent, as plain text (the replay's sentences go to the web page
 * and the bot alike). A need rounds UP, a holding DOWN; a small copy's figures
 * are cents, so whole AUSD would read as nothing.
 */
export function ausdText(amountCNS: bigint, mode: 'floor' | 'ceil', collateralDecimals = 6): string {
  const cent = collateralDecimals >= 2 ? pow10(collateralDecimals - 2) : 1n;
  const cents = mode === 'ceil' ? ceilDiv(amountCNS, cent) : floorDiv(amountCNS, cent);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${whole}.${(abs % 100n).toString().padStart(2, '0')} AUSD`;
}

const sizeText = (units: bigint, decimals: number): string => {
  const whole = units / pow10(decimals);
  const frac = (units % pow10(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
};

export function replayCopy(input: ReplayInput): ReplayResult {
  const s = input.source;
  if (s.openedInWindow > input.cap) {
    return { kind: 'too-busy', accountId: s.accountId, openedInWindow: s.openedInWindow, cap: input.cap, fromMs: s.fromMs, toMs: s.toMs };
  }
  if (input.followerEquityCNS <= 0n) return { kind: 'no-follower-equity', accountId: s.accountId };
  const d = s.collateralDecimals;
  const acting = new Map(input.actingMarkets.map((m) => [m.symbol.toUpperCase(), m]));

  // Every event that moves either side's equity, in time order. At a tie a
  // close lands before an open: money freed at that instant is usable then.
  type Ev = { atMs: number; order: number; apply: () => void };
  const events: Ev[] = [];
  let leaderEq = s.equityAtStartCNS;
  let followerEq = input.followerEquityCNS;
  let committed = 0n;
  let lowestFree = followerEq;
  const curve: { atMs: number; equityCNS: bigint }[] = [{ atMs: s.fromMs, equityCNS: followerEq }];
  for (const f of s.flows) events.push({ atMs: f.atMs, order: 0, apply: () => { leaderEq += f.deltaCNS; } });
  for (const f of s.feesByDay) events.push({ atMs: f.atMs, order: 0, apply: () => { leaderEq -= f.feesCNS; } });
  for (const c of s.closedFromBefore) events.push({ atMs: c.atMs, order: 0, apply: () => { leaderEq += c.netPnlCNS; } });
  for (const p of s.positions) {
    if (p.status !== 'open' && p.closedAtMs !== undefined) events.push({ atMs: p.closedAtMs, order: 0, apply: () => { leaderEq += p.netPnlCNS; } });
  }

  const byTime = (a: Ev, b: Ev): number => a.atMs - b.atMs || a.order - b.order;
  let cursor = 0;
  const schedule = (ev: Ev): void => {
    let lo = cursor + 1;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byTime(events[mid]!, ev) <= 0) lo = mid + 1;
      else hi = mid;
    }
    events.splice(lo, 0, ev);
  };

  const trades: ReplayTrade[] = [];
  const skippedBy: Partial<Record<SkipReason, number>> = {};
  const notListed = new Map<string, number>();
  let closedResult = 0n;
  let openEstimate = 0n;
  let fees = 0n;
  let forcedExits = 0;
  let wins = 0;
  let losses = 0;
  let leaderOnCopied = 0n;

  const skip = (reason: SkipReason, text: string): ReplaySkip => {
    skippedBy[reason] = (skippedBy[reason] ?? 0) + 1;
    return { kind: 'skipped', reason, text };
  };

  for (const p of s.positions) {
    events.push({
      atMs: p.openedAtMs,
      order: 1,
      apply: () => {
        const symbol = describeMarket(p.market);
        const leverage = leverageOf(p, d);
        const base = {
          key: p.key,
          symbol,
          side: p.side,
          status: p.status,
          openedAtMs: p.openedAtMs,
          closedAtMs: p.closedAtMs,
          leader: { peakLotLNS: p.peakLotLNS, lotDecimals: p.lotDecimals, peakMarginCNS: p.peakMarginCNS, netPnlCNS: p.netPnlCNS, leverage },
        };
        const market = p.market.symbol === undefined ? undefined : acting.get(p.market.symbol.toUpperCase());
        let copy: ReplayCopy | ReplaySkip;
        if (market === undefined) {
          notListed.set(symbol, (notListed.get(symbol) ?? 0) + 1);
          copy = skip('not-listed', `${symbol} is not listed on ${input.actingNetwork}.`);
        } else if (p.peakLotLNS <= 0n) {
          copy = skip('no-size', 'The index has no size for this position.');
        } else if (p.entryPricePNS === undefined) {
          copy = skip('no-entry', 'The index has no entry price for this position, so its cost cannot be worked out.');
        } else if (leaderEq <= 0n) {
          copy = skip('leader-no-equity', 'The leader had no equity on record at that moment, so there is no proportion to copy.');
        } else if (leverage !== undefined && leverage > market.maxLeverage) {
          copy = skip('leverage', `${leverage.toFixed(1)}x is above ${input.actingNetwork}'s ${market.maxLeverage}x maximum on ${market.symbol}.`);
        } else {
          // Scale = followerEq / leaderEq; size in the acting market's units, rounded down.
          const num = followerEq * pow10(market.sizeDecimals);
          const den = leaderEq * pow10(p.lotDecimals);
          const sizeUnits = (p.peakLotLNS * num) / den;
          if (sizeUnits <= 0n) {
            copy = skip('too-small', `At your size this is under ${sizeText(1n, market.sizeDecimals)} ${market.symbol}, the smallest size ${input.actingNetwork} takes.`);
          } else {
            // Effective scale after rounding: copy size over the leader's peak, in a common unit.
            const effNum = sizeUnits * pow10(p.lotDecimals);
            const effDen = p.peakLotLNS * pow10(market.sizeDecimals);
            const marginCNS = ceilDiv(p.peakMarginCNS * effNum, effDen);
            const free = followerEq - committed;
            if (marginCNS > free) {
              copy = skip('no-balance', `It needed ${ausdText(marginCNS, 'ceil', d)} of margin; your free balance was ${ausdText(free < 0n ? 0n : free, 'floor', d)}.`);
            } else {
              committed += marginCNS;
              lowestFree = followerEq - committed < lowestFree ? followerEq - committed : lowestFree;
              const scale = Number((effNum * 1_000_000n) / effDen) / 1_000_000;
              // Open and close, full size, at the entry price, the taker's rate: rounded up.
              const notionalCNS = sizeUnits * p.entryPricePNS * pow10(d);
              const feeCNS = ceilDiv(2n * notionalCNS * BigInt(market.takerFeeMicros), pow10(market.sizeDecimals + p.priceDecimals) * 1_000_000n);
              fees += feeCNS;
              if (p.status === 'open') {
                const leaderResult = openResultCNS(p, input.markOf(p.market.marketId), d);
                const resultCNS = leaderResult === undefined ? undefined : floorDiv(leaderResult * effNum, effDen) - feeCNS;
                if (resultCNS !== undefined) openEstimate += resultCNS;
                copy = { kind: 'copied', actingMarketId: market.marketId, sizeUnits, sizeDecimals: market.sizeDecimals, marginCNS, feeCNS, resultCNS, estimate: true, scale };
              } else {
                const resultCNS = floorDiv(p.netPnlCNS * effNum, effDen) - feeCNS;
                leaderOnCopied += p.netPnlCNS;
                closedResult += resultCNS;
                if (p.status === 'forced') forcedExits += 1;
                // Won or lost by the LEADER's result, as a round trip is everywhere else; a forced exit is a loss.
                if (p.status !== 'forced' && p.netPnlCNS > 0n) wins += 1;
                else losses += 1;
                copy = { kind: 'copied', actingMarketId: market.marketId, sizeUnits, sizeDecimals: market.sizeDecimals, marginCNS, feeCNS, resultCNS, estimate: false, scale };
                // The copy closes when the leader's does: its margin comes back with its result.
                const closedAt = p.closedAtMs;
                if (closedAt !== undefined) {
                  schedule({
                    atMs: closedAt,
                    order: 0,
                    apply: () => {
                      committed -= marginCNS;
                      followerEq += resultCNS;
                      curve.push({ atMs: closedAt, equityCNS: followerEq });
                    },
                  });
                }
              }
            }
          }
        }
        trades.push({ ...base, copy });
      },
    });
  }

  events.sort(byTime);
  // A copy's close is scheduled while the walk runs: inserted in time order,
  // never before the event that scheduled it (a close can share its open's instant).
  for (cursor = 0; cursor < events.length; cursor += 1) events[cursor]!.apply();

  // The leader's books, walked to today by the same rule that scaled every copy.
  const rebuiltNow =
    s.equityAtStartCNS +
    s.flows.reduce((a, f) => a + f.deltaCNS, 0n) +
    s.closedFromBefore.reduce((a, c) => a + c.netPnlCNS, 0n) +
    s.positions.filter((p) => p.status !== 'open').reduce((a, p) => a + p.netPnlCNS, 0n) -
    s.feesByDay.reduce((a, f) => a + f.feesCNS, 0n) +
    s.now.openResultCNS;
  const books = reconcile(rebuiltNow, s.now.freeCNS + s.now.openMarginCNS, d);

  const copiedCount = trades.filter((t) => t.copy.kind === 'copied').length;
  if (s.openAtStart > 0) skippedBy['open-at-start'] = s.openAtStart;
  return {
    kind: 'replayed',
    accountId: s.accountId,
    fromMs: s.fromMs,
    toMs: s.toMs,
    actingNetwork: input.actingNetwork,
    collateralDecimals: d,
    followerStartCNS: input.followerEquityCNS,
    leaderStartCNS: s.equityAtStartCNS,
    trades,
    books,
    curve,
    totals: {
      copied: copiedCount,
      skipped: trades.length - copiedCount + s.openAtStart,
      skippedBy,
      notListed: [...notListed].map(([symbol, count]) => ({ symbol, count })).sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol)),
      closedResultCNS: closedResult,
      openEstimateCNS: openEstimate,
      feesCNS: fees,
      forcedExits,
      wins,
      losses,
      leaderResultOnCopiedCNS: leaderOnCopied,
      followerEndEquityCNS: followerEq,
      lowestFreeCNS: lowestFree,
    },
  };
}
