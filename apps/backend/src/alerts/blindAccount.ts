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
import { freshness, NO_BUTTONS } from './plain.ts';
import type { AlertMessage } from './types.ts';

/** One position in the spell: its latest assessment. */
export type SpellMember = Pick<RiskAssessment, 'symbol' | 'side' | 'state' | 'atMs'>;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nameOf = (m: SpellMember): string => (m.side === undefined ? m.symbol : `${m.symbol} ${m.side}`);
const listOf = (members: readonly SpellMember[]): string => members.map(nameOf).join(', ');
const count = (n: number): string => (n === 1 ? '1 position' : `${n} positions`);

/** The cause now: the most recently assessed member's. Positions untrusted wins a tie, as it does per position. */
export function causeOf(members: readonly SpellMember[]): 'FEED_DOWN' | 'POSITIONS_UNTRUSTED' {
  const latest = [...members].sort((a, b) => b.atMs - a.atMs)[0];
  return latest?.state === 'FEED_DOWN' ? 'FEED_DOWN' : 'POSITIONS_UNTRUSTED';
}

const accountOf = (base: AlertMessage): number | undefined => base.watch?.accountId ?? base.accountId;

/** "I cannot see N positions", once, after the quiet minute. */
export function accountBlindMessage(base: AlertMessage, members: readonly SpellMember[], lastedMs: number, nowMs: number): AlertMessage {
  const cause = causeOf(members);
  const account = accountOf(base);
  const who = account === undefined ? 'your account' : `#${account}`;
  const why =
    cause === 'FEED_DOWN'
      ? 'The price feed is down, so I cannot tell how close any of them is to being closed.'
      : 'I have lost track of the positions themselves: what you last saw may no longer be true.';
  const minutes = Math.floor(lastedMs / 60_000);
  const lasted = minutes >= 1 ? `for ${minutes} minute${minutes === 1 ? '' : 's'}` : `for ${Math.round(lastedMs / 1000)}s`;
  const title = `CANNOT SEE · ${who}`;
  const lines = [
    `I have not been able to see ${count(members.length)} ${lasted}: ${listOf(members)}.`,
    why,
    'I will say so once, when I can see them again.',
  ];
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
      : {
          html: [
            `⚪ <b>#${base.watch.accountId}: I cannot see ${count(members.length)} right now</b>`,
            esc(listOf(members)),
            esc(why),
            'I will say so once, when I can see them again.',
            freshness(base.watch, { priceIsOld: false, priceAgeMs: undefined }),
            NO_BUTTONS,
          ].join('\n'),
        }),
  };
}

/** "I can see them again", once, when the last blind position clears. A RECOVERY FROM BLIND, never a claim about risk. */
export function accountClearMessage(base: AlertMessage, names: readonly string[], blindFor: RiskState, lastedMs: number, nowMs: number, state: RiskState): AlertMessage {
  const account = accountOf(base);
  const who = account === undefined ? 'your account' : `#${account}`;
  const title = `CAN SEE AGAIN · ${who}`;
  const s = Math.round(lastedMs / 1000);
  const lasted = s >= 120 ? `${Math.round(s / 60)} minutes` : `${s}s`;
  const lines = [
    `I can see ${names.length === 1 ? 'it' : 'them'} again after ${lasted}${names.length === 0 ? '' : `: ${names.join(', ')}`}.`,
    base.watch === undefined ? 'My Positions shows where each one stands now.' : 'Where each one stands now is on its page.',
  ];
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
      : {
          html: [`🟢 <b>#${base.watch.accountId}: I can see ${names.length === 1 ? 'it' : 'them'} again</b>`, esc(lines[0]!), freshness(base.watch, { priceIsOld: false, priceAgeMs: undefined }), NO_BUTTONS].join('\n'),
        }),
  };
}
