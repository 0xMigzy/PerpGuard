/** `/help` — one sentence each, and the isolated-margin fact that explains the bot. */
export const HELP_TEXT = [
  'PerpGuard watches your Perpl positions and warns you before a liquidation.',
  '',
  '/positions — every open position with its buffer, liquidation price and what a top-up would buy.',
  '/status — whether I can actually see right now: feed connection, position list, and how old the data is.',
  '/start — link this chat to the account I alert.',
  '/web — a one-time code to sign in to the Protect page in the web app.',
  '/cancel — drop a custom amount I am waiting for.',
  '/help — this.',
  '',
  'Every top-up comes with what it buys: the buffer and liquidation price it leaves you at.',
  'That holds for an amount you pick yourself — tap Custom amount, reply with a figure, and I',
  'work out the same two numbers before anything is sent.',
  '',
  'Perpl uses isolated margin: each position has its own collateral, and your free',
  'AUSD is never pulled in to rescue a losing one. That is the whole reason I exist.',
  'Adding margin is explicit, per position, and you confirm it — I never trade on my own.',
].join('\n');

/**
 * What an unlinked chat is told, and what an unauthorised tap is answered with.
 *
 * FLAT AND IDENTICAL for every rejected case, on purpose. A refusal that varied
 * — "no user is linked" versus "someone else is linked" — would tell a stranger
 * whether they are first, which is the one thing worth knowing to a person
 * probing a bot whose token has leaked.
 */
export const REFUSAL_TEXT =
  'PerpGuard is not linked to you. This bot answers one account and nobody else.';

/** Shown to a linked user who spoke to the bot from somewhere other than their linked chat. */
export const WRONG_CHAT_TEXT =
  'PerpGuard only answers in the chat it was linked in. Your position data does not ' +
  'go anywhere else. Send /start there, or unlink and link again from here.';
