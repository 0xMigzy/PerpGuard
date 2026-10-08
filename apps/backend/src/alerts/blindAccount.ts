/**
 * ONE MESSAGE PER ACCOUNT FOR A BLIND SPELL (owner, 8 Oct 2026). A feed drop
 * blinds every position of an account at once; one message names them all,
 * and one more says when they can all be seen again. Pure: the engine decides
 * when, this decides the words.
 *
 * The message keeps the identity fields of the spell's FIRST position (market,
 * symbol, position id) so every filter downstream that keys on them (the
 * startup gate's "drop the recovery of a dropped blindness") pairs the two
 * messages of one spell. Its text speaks for the account.
 */
import type { RiskAssessment, RiskState } from '../risk/types.ts';
import { NO_BUTTONS } from './plain.ts';
import type { AlertMessage } from './types.ts';

/** One position in the spell: its latest assessment. */
export type SpellMember = Pick<RiskAssessment, 'symbol' | 'side' | 'state' | 'atMs'>;


/** The cause now: the most recently assessed member's. Positions untrusted wins a tie, as it does per position. */
export function causeOf(members: readonly SpellMember[]): 'FEED_DOWN' | 'POSITIONS_UNTRUSTED' {
  const latest = [...members].sort((a, b) => b.atMs - a.atMs)[0];
  return latest?.state === 'FEED_DOWN' ? 'FEED_DOWN' : 'POSITIONS_UNTRUSTED';
}


/**
 * "I've lost sight of your positions", once, after the quiet minute (owner's
 * wording, 8 Oct 2026). A watcher hears the account's number instead, and
 * nothing about automation, which a watcher has none of.
 */
export function accountBlindMessage(base: AlertMessage, members: readonly SpellMember[], _lastedMs: number, nowMs: number): AlertMessage {
  const cause = causeOf(members);
  const title = "I've lost sight of your positions and I'm reconnecting.";
  const lines = ['Nothing automatic will run until I can see again.'];
  return {
    ...base,
    kind: cause === 'FEED_DOWN' ? 'feed-down' : 'positions-untrusted',
    state: cause,
    atMs: nowMs,
    title,
    lines,
    text: [title, ...lines].join('\n'),
    actions: [],
    ...(base.watch === undefined
      ? {}
      : { html: [`⚪ I've lost sight of #${base.watch.accountId}'s positions and I'm reconnecting.`, '', NO_BUTTONS].join('\n') }),
  };
}

/** "I can see your positions again", once, when the last blind position clears. A RECOVERY FROM BLIND, never a claim about risk. */
export function accountClearMessage(base: AlertMessage, _names: readonly string[], blindFor: RiskState, lastedMs: number, nowMs: number, state: RiskState): AlertMessage {
  const minutes = Math.max(1, Math.round(lastedMs / 60_000));
  const title = 'I can see your positions again.';
  const lines = [`I was blind for about ${minutes} minute${minutes === 1 ? '' : 's'}. My positions shows where they are now.`];
  return {
    ...base,
    kind: 'recovered',
    state,
    previousState: blindFor,
    atMs: nowMs,
    title,
    lines,
    text: [title, ...lines].join('\n'),
    actions: [],
    ...(base.watch === undefined
      ? {}
      : { html: [`🟢 I can see #${base.watch.accountId}'s positions again.`, '', NO_BUTTONS].join('\n') }),
  };
}
