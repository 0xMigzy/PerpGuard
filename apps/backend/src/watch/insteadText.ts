/**
 * 👁 WATCH IT INSTEAD: what the chat hears when the /link page watches a
 * mainnet account its wallet owns. One place, so the bot map shows the real words.
 */
export function watchInsteadText(accountId: number): string {
  return `👁 Watching your mainnet account #${accountId}.\nI'll message you here before a position gets close to liquidation, and when one opens or closes. Watching only — nothing here to press.`;
}
