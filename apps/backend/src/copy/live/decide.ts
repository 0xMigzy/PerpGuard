/**
 * 🔁 COPY TRADING, HALF B: what to do about each thing the leader did. Pure.
 *
 * OPENS AND CLOSES ONLY (owner, 7 Oct 2026). The index keeps a position's open
 * and close but not the adds and reduces between, and a 30-second read would
 * mistime them; a copy that half-tracks someone's sizing is worse than one
 * that cleanly tracks their entries and exits.
 *
 * `plan` turns the leader's positions and the legs already recorded into
 * steps; `decideOpen` sizes one open or says why it is skipped. No caps on how
 * much is copied: ten opens are ten copies. The one number is the free balance
 * never spent, and an open that would go under it is SKIPPED AND SAID.
 */
import { describeMarket, type CopySourcePosition, type Side } from '@perpguard/shared';
import type { CopyLeg, CopyRule } from './store.ts';

export type Step =
  | { readonly kind: 'open'; readonly leader: CopySourcePosition }
  /** Opened and closed between two looks: never copied, recorded as skipped. */
  | { readonly kind: 'missed'; readonly leader: CopySourcePosition }
  | { readonly kind: 'close'; readonly leg: CopyLeg; readonly leader: CopySourcePosition };

/** Steps in time order: opens by their open, closes by their close. */
export function plan(rule: Pick<CopyRule, 'startedAtMs'>, legs: readonly CopyLeg[], leader: readonly CopySourcePosition[]): readonly Step[] {
  const byKey = new Map(legs.map((l) => [l.leaderKey, l]));
  const steps: Array<Step & { at: number }> = [];
  for (const p of leader) {
    if (p.openedAtMs < rule.startedAtMs) continue;
    const leg = byKey.get(p.key);
    if (leg === undefined) {
      steps.push(p.status === 'open' ? { kind: 'open', leader: p, at: p.openedAtMs } : { kind: 'missed', leader: p, at: p.openedAtMs });
    } else if (leg.status === 'open' && p.status !== 'open') {
      steps.push({ kind: 'close', leg, leader: p, at: p.closedAtMs ?? p.openedAtMs });
    }
  }
  return steps.sort((a, b) => a.at - b.at);
}

/** One market on the ACTING network, with its current mark. */
export interface ActingCopyMarket {
  readonly marketId: number;
  readonly symbol: string;
  readonly sizeDecimals: number;
  readonly maxLeverage: number;
  /** The acting network's mark now, as a price. Undefined: no price, no copy. */
  readonly markPrice: number | undefined;
}

export interface OpenInput {
  readonly leader: CopySourcePosition;
  /** The leader's equity now, from the index's books (free balance + open margin). */
  readonly leaderEquityCNS: bigint;
  /** The follower's equity now (free floor + margin in open positions). */
  readonly followerEquityCNS: bigint;
  /** The follower's free balance floor now. Undefined: not known, no copy. */
  readonly followerFreeCNS: bigint | undefined;
  readonly keepFreeCNS: bigint;
  /** Found by the leader market's CONTEXT ticker on the acting network. */
  readonly acting: ActingCopyMarket | undefined;
  readonly actingNetwork: string;
  /** The follower already holds a position on that market (their own, or another copy). */
  readonly followerHoldsMarket: boolean;
  readonly collateralDecimals: number;
}

export type OpenDecision =
  | {
      readonly kind: 'send';
      readonly actingMarketId: number;
      readonly symbol: string;
      readonly side: Side;
      readonly sizeLNS: bigint;
      readonly sizeDecimals: number;
      readonly leverageHundredths: number;
      /** Leader's leverage was above the acting maximum and the copy uses the maximum: said in the message. */
      readonly leverageCapped: boolean;
      readonly notionalCNS: bigint;
      /** Margin the open needs, rounded UP. */
      readonly marginCNS: bigint;
      /** The copy's share: follower equity over leader equity. */
      readonly share: number;
    }
  | { readonly kind: 'skip'; readonly reason: CopySkip; readonly text: string };

export type CopySkip = 'not-listed' | 'holds-market' | 'no-size' | 'no-price' | 'leader-no-equity' | 'too-small' | 'floor' | 'balance-unknown';

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a % b === 0n ? a / b : a / b + 1n);
const ausd = (cns: bigint, d: number, mode: 'ceil' | 'floor'): string => {
  const cent = d >= 2 ? pow10(d - 2) : 1n;
  const c = mode === 'ceil' ? ceilDiv(cns < 0n ? 0n : cns, cent) : (cns < 0n ? 0n : cns) / cent;
  return `${(c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(c % 100n).toString().padStart(2, '0')} AUSD`;
};

/**
 * Sized by NOTIONAL, proportional to the account (2% -> 2%): the leader's
 * position value at entry, times follower equity over leader equity, divided
 * by the ACTING mark. Prices differ between networks, so copying lots would
 * copy a different exposure.
 */
export function decideOpen(input: OpenInput): OpenDecision {
  const p = input.leader;
  const name = describeMarket(p.market);
  const d = input.collateralDecimals;
  const a = input.acting;
  const skip = (reason: CopySkip, text: string): OpenDecision => ({ kind: 'skip', reason, text });
  if (a === undefined) return skip('not-listed', `${name} is not listed on ${input.actingNetwork}, so it cannot be copied.`);
  if (input.followerHoldsMarket) return skip('holds-market', `You already hold a ${a.symbol} position on ${input.actingNetwork}; a copy would change it rather than open one.`);
  if (p.entryPricePNS === undefined || p.lotLNS <= 0n) return skip('no-size', `The index has no size or entry price for this ${name} position.`);
  if (a.markPrice === undefined || !Number.isFinite(a.markPrice) || a.markPrice <= 0) return skip('no-price', `There is no ${input.actingNetwork} price for ${a.symbol} right now.`);
  if (input.leaderEquityCNS <= 0n) return skip('leader-no-equity', 'The leader has no equity on record, so there is no proportion to copy.');
  if (input.followerFreeCNS === undefined) return skip('balance-unknown', 'Your free balance is not known right now, so nothing was sent.');

  const leaderNotionalCNS = (p.lotLNS * p.entryPricePNS * pow10(d)) / pow10(p.lotDecimals + p.priceDecimals);
  const notionalCNS = (leaderNotionalCNS * input.followerEquityCNS) / input.leaderEquityCNS;
  const markCNS = BigInt(Math.round(a.markPrice * 10 ** d));
  const sizeLNS = (notionalCNS * pow10(a.sizeDecimals)) / markCNS;
  if (sizeLNS <= 0n) return skip('too-small', `At your size this ${a.symbol} copy comes to less than the smallest size ${input.actingNetwork} takes.`);

  const leaderLev = p.leverageHdths > 0n ? Number(p.leverageHdths) / 100 : p.peakMarginCNS > 0n ? Number((leaderNotionalCNS * 100n) / p.peakMarginCNS) / 100 : 1;
  const lev = Math.max(1, Math.min(leaderLev, a.maxLeverage));
  const leverageHundredths = Math.floor(lev * 100);
  const sizedNotionalCNS = (sizeLNS * markCNS) / pow10(a.sizeDecimals);
  const marginCNS = ceilDiv(sizedNotionalCNS * 100n, BigInt(leverageHundredths));
  if (input.followerFreeCNS - marginCNS < input.keepFreeCNS) {
    return skip(
      'floor',
      `Not copied: it needs about ${ausd(marginCNS, d, 'ceil')} of margin, and your free balance (${ausd(input.followerFreeCNS, d, 'floor')}) would fall below the ${ausd(input.keepFreeCNS, d, 'floor')} you keep free.`,
    );
  }
  return {
    kind: 'send',
    actingMarketId: a.marketId,
    symbol: a.symbol,
    side: p.side,
    sizeLNS,
    sizeDecimals: a.sizeDecimals,
    leverageHundredths,
    leverageCapped: leaderLev > a.maxLeverage,
    notionalCNS: sizedNotionalCNS,
    marginCNS,
    share: Number((input.followerEquityCNS * 1_000_000n) / input.leaderEquityCNS) / 1_000_000,
  };
}
