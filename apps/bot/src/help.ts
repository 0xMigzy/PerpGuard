/** `/help` — one sentence each, and the isolated-margin fact that explains the bot. */
export const HELP_TEXT = [
  'PerpGuard watches Perpl positions and warns before a liquidation.',
  '',
  'Everything is on buttons: send /start for the menu.',
  '',
  'Watch any account — no wallet, no sign-up, no link:',
  '/watch <0x address or account id> — alert this chat about that account’s positions. Read-only: no buttons.',
  'Or just paste an address or account id. My watchlist (on the menu) shows them all and stops one.',
  '',
  'Your own account, linked, with the buttons to act:',
  '/link — a one-time page where you prove you own your Perpl account (wallet signature, or an API key pasted there and nowhere else).',
  '/unlink — remove the link, delete the key, stop the session. Immediate.',
  '/positions — every open position with its buffer, liquidation price and what a top-up would buy.',
  '/status — whether I can actually see right now: feed connection, position list, and how old the data is.',
  '/cancel — drop a custom amount I am waiting for.',
  '/help — this.',
  '/start — who you are here, and which tier this chat is on.',
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
  'PerpGuard is not linked to you, so that is off: this bot acts for one account and nobody else. ' +
  'You can still watch any account, read-only: paste its address or account id, or send /start for the menu.';

/** Shown to a linked user who spoke to the bot from somewhere other than their linked chat. */
export const WRONG_CHAT_TEXT =
  'PerpGuard only answers in the chat it was linked in. Your position data does not ' +
  'go anywhere else. Send /start there, or unlink and link again from here.';

/**
 * The command menu Telegram shows next to the text box. Only what is faster
 * typed than tapped: everything else lives on a button, and listing it here
 * would teach people the slower way to use the bot.
 */
export const BOT_MENU_COMMANDS: readonly { readonly command: string; readonly description: string }[] = [
  { command: 'start', description: 'The menu' },
  { command: 'watch', description: 'Watch an address or account id' },
  { command: 'link', description: 'Connect your own account' },
  { command: 'help', description: 'What PerpGuard does' },
];
