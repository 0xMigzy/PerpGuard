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
import { distance, esc, money, held as heldMoney } from '../alerts/plain.ts';
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
  | { readonly kind: 'exhausted'; readonly rule: RescueRule; readonly assessment: RiskAssessment; readonly why: string }
  | { readonly kind: 'held'; readonly rule: RescueRule; readonly reason: HoldReason; readonly detail: string; readonly assessment: RiskAssessment | undefined }
  | { readonly kind: 'ended'; readonly rule: RescueRule; readonly detail: string };

export interface RenderedRescue {
  readonly html: string;
  readonly buttons: readonly RescueButton[];
}

const name = (r: RescueRule): string => esc(r.symbol);
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`;
const used = (r: RescueRule): string => `${r.rescueCount} / ${r.maxRescues}`;

export function renderRescue(n: RescueNotice): RenderedRescue {
  switch (n.kind) {
    case 'rescued': {
      const lines = [
        '🛟 <b>POSITION RESCUED</b>',
        '',
        `<b>${name(n.rule)}</b>`,
        '',
        `Trigger: ${distance(n.triggerDistancePct)}`,
        `Margin added: ${money(n.appliedCNS, 'floor')}`,
        `Margin: ${money(n.marginBeforeCNS, 'floor')} → ${money(n.marginAfterCNS, 'floor')}`,
        n.distanceAfterPct === undefined
          ? 'New distance: not re-measured yet. My Positions shows it.'
          : `New distance: <b>${distance(n.distanceAfterPct)}</b>`,
        `Rescues: ${used(n.rule)}`,
      ];
      if (n.receiptDisagreed) {
        lines.push(
          '',
          "The exchange's own report disagreed with what actually happened.",
          'The margin applied — I checked the position itself, not the receipt.',
          'Do not add it again by hand.',
        );
      }
      return { html: lines.join('\n'), buttons: [{ text: '📊 View Position', route: 'position' }, { text: '🔴 Stop Rescue', route: 'rescue-stop' }] };
    }
    case 'not-applied':
      return {
        html: [
          `🛟 <b>RESCUE DID NOT LAND</b>`,
          '',
          `<b>${name(n.rule)}</b>`,
          '',
          `I sent ${money(n.amountCNS, 'ceil')} and then checked the position: its margin did not move.`,
          'Nothing was added, so nothing can have been added twice.',
          `Rescue tries again after the ${minutes(n.cooldownMs)} cooldown if the position is still at its trigger.`,
        ].join('\n'),
        buttons: [{ text: '📊 View Position', route: 'position' }, { text: '🔴 Stop Rescue', route: 'rescue-stop' }],
      };
    case 'paused':
      return {
        html: [
          `🛟 <b>RESCUE PAUSED</b>`,
          '',
          `<b>${name(n.rule)}</b>`,
          '',
          `I sent ${money(n.amountCNS, 'ceil')} and could not confirm from the position whether it landed.`,
          'Check the position before adding anything: it may already be there.',
          'Rescue is paused on this position and will not send again until you turn it back on.',
          '',
          `<i>${esc(n.detail)}</i>`,
        ].join('\n'),
        buttons: [{ text: '📊 View Position', route: 'position' }, { text: '🛟 Rescue', route: 'rescue' }],
      };
    case 'exhausted':
      return {
        html: [
          `🛟 <b>RESCUE LIMITS REACHED — OVER TO YOU</b>`,
          '',
          `<b>${name(n.rule)}</b> is <b>${distance(n.assessment.liqBufferPct)}</b> and still falling.`,
          '',
          `Rescues used: ${used(n.rule)}`,
          `Total added: ${money(n.rule.totalRescuedCNS, 'floor')} of a ${money(n.rule.maxTotalCNS, 'floor')} cap`,
          '',
          `The limits you set have done their job, so PerpGuard has stopped adding margin to this position (${esc(n.why)}).`,
          '',
          'What you can still do:',
          '• Add margin yourself',
          '• Reduce the position (the closing price does not move: margin is released in proportion)',
          '• Close it',
        ].join('\n'),
        buttons: [{ text: '📊 Open the position', route: 'position' }],
      };
    case 'held':
      return {
        html: [
          `🛟 <b>RESCUE WAITING</b>`,
          '',
          `<b>${name(n.rule)}</b>${n.assessment === undefined ? '' : ` is <b>${distance(n.assessment.liqBufferPct)}</b>`}, at its rescue trigger.`,
          '',
          `Nothing was sent: ${esc(n.detail)}.`,
          HOLD_NEXT[n.reason](n.rule),
        ].join('\n'),
        buttons: [{ text: '📊 View Position', route: 'position' }],
      };
    case 'ended':
      return {
        html: [`🛟 <b>RESCUE ENDED</b>`, '', `Rescue for <b>${name(n.rule)}</b> has ended: ${esc(n.detail)}.`, 'A new position needs its own rule.'].join('\n'),
        buttons: [{ text: '🛟 Rescue', route: 'rescue' }],
      };
  }
}

const HOLD_NEXT: Record<HoldReason, (r: RescueRule) => string> = {
  stopped: () => 'Automation is stopped. Rescue acts again once you turn it back on.',
  'feed-down': () => 'It will act once prices are live again.',
  'positions-untrusted': () => 'It will act once I can see your positions again.',
  cooldown: (r) => `Rescues on one position are at least ${minutes(r.cooldownMs)} apart. Add margin yourself if it cannot wait.`,
  'balance-unknown': () => 'It will act once I can see your balance.',
  'balance-low': (r) => `Rescue never takes your free balance below ${heldMoney(r.minRemainingCNS)}. Add margin yourself if you want to go below it.`,
  'no-session': () => 'It will act once the account reconnects.',
  'in-flight': () => 'It will look again once that action has settled.',
  refused: () => 'It will look again in a minute.',
};
