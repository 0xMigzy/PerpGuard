/**
 * What Rescue says, in the bot's plain voice (`alerts/plain.ts`): money first
 * and in bold, what was ADDED floored, a negative buffer is "past its closing
 * price", never the word "safe".
 *
 * Five things to say, and only five:
 *   rescued      spec 44. The verified figures: margin before -> after off the
 *                POSITION, the distance re-measured after it landed.
 *   not-applied  sent, the position did not move. It will try again after the cooldown.
 *   paused       sent, and nobody can say whether it landed. Rescue stops on
 *                this position until the person looks and turns it back on.
 *   exhausted    THE HANDOVER (owner, 6 Oct 2026): the limits are spent and the
 *                position is still falling. Rescues used, total added, current
 *                distance, that PerpGuard has stopped, and what the trader can
 *                still do. Not a failure: the limits did their job.
 *   held         triggered, and something says not now. Said once per reason.
 *   ended        the position is gone, so its rule is.
 */
import { distance, esc, money as moneyIn, held as heldIn } from '../alerts/plain.ts';
import type { RiskAssessment } from '../risk/types.ts';
import type { HoldReason } from './decide.ts';
import type { RescueRule } from './store.ts';

export type RescueButton = { readonly text: string; readonly route: 'position' | 'rescue' | 'rescue-stop' };

export type RescueNotice =
  | {
      readonly kind: 'rescued';
      readonly rule: RescueRule;
      readonly triggerDistancePct: number;
      readonly appliedCNS: bigint;
      readonly marginBeforeCNS: bigint;
      readonly marginAfterCNS: bigint;
      /** Re-measured off the loop after the margin landed. Undefined when it had not been yet. */
      readonly distanceAfterPct: number | undefined;
      /** The `t: 6` case: the receipt said rejected while the position shows the margin. */
      readonly receiptDisagreed: boolean;
    }
  | { readonly kind: 'not-applied'; readonly rule: RescueRule; readonly amountCNS: bigint; readonly cooldownMs: number }
  | { readonly kind: 'paused'; readonly rule: RescueRule; readonly amountCNS: bigint; readonly detail: string }
  /** Refused before sending, the same way twice in a row: nothing was sent either time. */
  | { readonly kind: 'paused-refused'; readonly rule: RescueRule; readonly detail: string }
  | { readonly kind: 'exhausted'; readonly rule: RescueRule; readonly assessment: RiskAssessment; readonly why: string }
  | { readonly kind: 'held'; readonly rule: RescueRule; readonly reason: HoldReason; readonly detail: string; readonly assessment: RiskAssessment | undefined }
  /**
   * `cause` says WHAT ended it. 'position': the fully loaded list no longer has
   * it. 'market': the exchange no longer lists the market, which says nothing
   * about the position and is never worded as if it did.
   */
  | { readonly kind: 'ended'; readonly rule: RescueRule; readonly detail: string; readonly cause: 'position' | 'market' };

export interface RenderedRescue {
  readonly html: string;
  readonly buttons: readonly RescueButton[];
}

const name = (r: RescueRule): string => esc(r.symbol);
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`;
/** `2.7%`, or `past` for a negative buffer: never a negative percentage. */
const short = (buffer: number | undefined): string => (buffer === undefined ? '—' : buffer < 0 ? 'past' : `${(buffer * 100).toFixed(1)}%`);

/**
 * `collateralDecimals` comes from the venue's own context (the collateral
 * token's decimals), never assumed to be 6.
 */
export function renderRescue(n: RescueNotice, collateralDecimals: number): RenderedRescue {
  const money = (cns: bigint, mode: 'floor' | 'ceil'): string => moneyIn(cns, mode, collateralDecimals);
  const heldMoney = (cns: bigint): string => heldIn(cns, collateralDecimals);
  switch (n.kind) {
    case 'rescued': {
      // OWNER'S WORDING (8 Oct 2026): what was added, the distance it bought, the limit used.
      const lines = [
        `🛟 <b>Added ${money(n.appliedCNS, 'floor').replace(/<\/?b>/g, '')} to ${name(n.rule)}</b>`,
        n.distanceAfterPct === undefined
          ? `${short(n.triggerDistancePct)} from liquidation before; My positions shows where it is now.`
          : `${short(n.triggerDistancePct)} → ${short(n.distanceAfterPct)} from liquidation`,
        `${n.rule.rescueCount} of your ${n.rule.maxRescues} top-up${n.rule.maxRescues === 1 ? '' : 's'} used.`,
      ];
      if (n.receiptDisagreed) {
        lines.push(
          '',
          "The exchange's own report disagreed with what actually happened.",
          'The margin applied — I checked the position itself, not the receipt.',
          '<b>Do not add it again by hand.</b>',
        );
      }
      return { html: lines.join('\n'), buttons: [{ text: '📊 View / close position', route: 'position' }, { text: '⛔ Turn off', route: 'rescue-stop' }] };
    }
    case 'not-applied':
      return {
        html: [
          `🛟 <b>The top-up didn't land on ${name(n.rule)}</b>`,
          '',
          `I sent ${money(n.amountCNS, 'ceil')} and then checked the position: its margin did not move.`,
          'Nothing was added, so nothing can have been added twice.',
          `Rescue tries again after the ${minutes(n.cooldownMs)} cooldown if the position is still at its trigger.`,
        ].join('\n'),
        buttons: [{ text: '📊 View / close position', route: 'position' }, { text: '⛔ Turn off', route: 'rescue-stop' }],
      };
    case 'paused':
      return {
        html: [
          `🛟 <b>Rescue paused on ${name(n.rule)}</b>`,
          '',
          `I sent ${money(n.amountCNS, 'ceil')} and couldn't confirm from the position whether it landed.`,
          'Check the position before adding anything: it may already be there.',
          'Rescue is paused on this position and will not send again until you turn it back on.',
          '',
          `<i>${esc(n.detail)}</i>`,
        ].join('\n'),
        buttons: [{ text: '📊 View / close position', route: 'position' }, { text: '🛟 Rescue', route: 'rescue' }],
      };
    case 'paused-refused':
      return {
        html: [
          `🛟 <b>Rescue paused on ${name(n.rule)}</b>`,
          '',
          'The exchange refused it twice in a row for the same reason, before anything was sent. Nothing was added either time.',
          'It is paused on this position so it does not keep trying against the same wall. Resume it from 🛟 Rescue once the cause has cleared.',
          '',
          `<i>${esc(n.detail)}</i>`,
        ].join('\n'),
        buttons: [{ text: '📊 View / close position', route: 'position' }, { text: '🛟 Rescue', route: 'rescue' }],
      };
    case 'exhausted': {
      // THE HANDOVER, in the owner's words (8 Oct 2026): not a failure, the limits did their job.
      const max = n.rule.maxRescues;
      const spent = max === 1 ? 'Your one top-up is used' : max === 2 ? 'Both top-ups used' : `All ${max} top-ups used`;
      return {
        html: [
          `🛟 <b>${spent}, ${name(n.rule)} is still falling</b>`,
          `${money(n.rule.totalRescuedCNS, 'floor').replace(/<\/?b>/g, '')} added. Now ${short(n.assessment.liqBufferPct)} from liquidation.`,
          'PerpGuard has stopped adding margin.',
          'You can add more yourself, or close it.',
        ].join('\n'),
        buttons: [{ text: '📊 View / close position', route: 'position' }, { text: '🛟 Rescue', route: 'rescue' }],
      };
    }
    case 'held':
      return {
        html: [
          BEFORE_TRIGGER.has(n.reason)
            ? `🛟 <b>Rescue can't judge ${name(n.rule)} right now</b>`
            : `🛟 <b>Rescue didn't add to ${name(n.rule)}</b>${n.assessment === undefined ? '' : ` · ${distance(n.assessment.liqBufferPct)}`}`,
          `Nothing was sent: ${esc(n.detail)}.`,
          HOLD_NEXT[n.reason](n.rule, heldMoney),
        ].join('\n'),
        buttons: [{ text: '📊 View / close position', route: 'position' }],
      };
    case 'ended':
      return {
        html: (n.cause === 'market'
          ? [
              `🛟 <b>Rescue ended for ${name(n.rule)}</b>`,
              '',
              `${esc(n.detail)}.`,
              'Nothing can be sent to a market the exchange no longer lists. This says nothing about the position itself: check it on Perpl.',
            ]
          : [`🛟 <b>Rescue ended for ${name(n.rule)}</b>`, '', `${esc(n.detail)}.`, 'A new position needs its own rule.']
        ).join('\n'),
        buttons: [{ text: '🛟 Rescue', route: 'rescue' }],
      };
  }
}

/** Holds decided before the trigger is even looked at: the message must not claim it is at its trigger. */
const BEFORE_TRIGGER: ReadonlySet<HoldReason> = new Set<HoldReason>(['positions-untrusted', 'unassessed']);

const HOLD_NEXT: Record<HoldReason, (r: RescueRule, heldMoney: (cns: bigint) => string) => string> = {
  stopped: () => 'Automation is stopped. Rescue acts again once you resume it under 🆘 Kill switch.',
  'feed-down': () => 'It will act once prices are live again.',
  'positions-untrusted': () => 'It will act once I can see your positions again.',
  unassessed: () => 'It will act once I can price the position. It is not closed.',
  'market-closed': () => 'It will act once the exchange reopens the market. Nothing is recorded as an attempt meanwhile.',
  cooldown: (r) => `Top-ups on one position are at least ${minutes(r.cooldownMs)} apart. Add margin yourself if it can't wait.`,
  'balance-unknown': () => 'It will act once I can see your balance.',
  'balance-low': (r, heldMoney) => `Rescue never takes your free balance below ${heldMoney(r.minRemainingCNS)}. Add margin yourself if you want to go below it.`,
  'no-session': () => 'It will act once the account reconnects.',
  'in-flight': () => 'It will look again once that action has settled.',
  refused: () => 'It will look again in a minute.',
};
