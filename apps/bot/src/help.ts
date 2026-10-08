/** `/help` — one sentence each, and the isolated-margin fact that explains the bot. */
export const HELP_TEXT = [
  'I message you before a Perpl position gets liquidated.',
  '',
  'Send /start for the menu. Everything is on buttons; /help shows this.',
  '',
  '👁 Watch any account: send its address or account number, or use /watch. No key, nothing to set up.',
  '',
  '🔐 Connect your own account with /link (a wallet signature or an API key, on a one-time page, never here). Then:',
  '📊 My positions shows how far each position is from liquidation, and adds margin when you tap and confirm.',
  '🛟 Rescue adds margin by itself at your alert distance, within limits you set. Off until you turn it on.',
  '🆘 Kill switch stops automation, and can close every position.',
  '',
  'Perpl uses isolated margin: each position has its own margin, and your free AUSD is never moved in to save one. That is why I exist.',
].join('\n');

/** Answered to a button from an older menu (the retired close-all kill switch, say). Nothing ran. */
export const OLD_MENU_TEXT = 'That button is from an older version of the menu. Nothing was sent. Send /start for the current one.';

/**
 * What an unlinked chat is told, and what an unauthorised tap is answered with.
 *
 * FLAT AND IDENTICAL for every rejected case, on purpose. A refusal that varied
 * — "no user is linked" versus "someone else is linked" — would tell a stranger
 * whether they are first, which is the one thing worth knowing to a person
 * probing a bot whose token has leaked.
 */
export const REFUSAL_TEXT =
  "That needs a connected account, and this chat doesn't have one. Connect yours with /link, " +
  'or watch any account: send its address or account number.';

/** Shown to a linked user who spoke to the bot from somewhere other than their linked chat. */
export const WRONG_CHAT_TEXT =
  "Your account is connected in another chat, and its positions are only shown there. " +
  'Send /start there, or disconnect and connect again from here.';

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
