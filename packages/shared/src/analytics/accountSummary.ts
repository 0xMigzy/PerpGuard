/**
 * ONE ACCOUNT'S MONEY, NOW: free + margin + unrealised = equity.
 *
 * Shared on purpose (12 Oct 2026): the trader page and the bot's /equity
 * reply both call this, so the two can never print different figures for the
 * same account. Pure; the caller supplies the profile and its priced positions.
 */

/** One account's money, now: what is free, what backs positions, what they would realise. */
export interface AccountSummary {
  readonly freeAusd: number;
  readonly marginAusd: number;
  /** Over PRICED positions only; see `unpriced`. */
  readonly unrealisedAusd: number;
  /** `free + margin + unrealised`, or undefined while any open position is unpriced: a partial sum is not equity. */
  readonly equityAusd: number | undefined;
  readonly positions: number;
  readonly unpriced: number;
  readonly depositedAusd: number;
  readonly withdrawnAusd: number;
  /** `deposited - withdrawn`: positive is net in, negative net out. */
  readonly netInAusd: number;
  /** `equity - netIn`: how far the account is up (+) or down (−) on what was put in. Undefined with equity. */
  readonly sinceFirstDepositAusd: number | undefined;
}

/** To whole cents, so the strip's arithmetic adds up exactly as printed. */
const cents = (ausd: number): number => Math.round(ausd * 100) / 100;

/**
 * The account summary from the profile and its priced positions. Every input
 * is rounded to the cent FIRST and equity is the sum of those, so
 * "free + margin + unrealised = equity" holds to the cent on screen. Funding
 * is not accrued between settlements (the contract settles it into the
 * position), so nothing is added for it.
 */
export function accountSummary(
  profile: { readonly freeBalanceAusd: number; readonly depositedAusd: number; readonly withdrawnAusd: number },
  positions: readonly { readonly position: { readonly marginAusd: number }; readonly unrealisedPnlAusd?: number | undefined }[],
): AccountSummary {
  const freeAusd = cents(profile.freeBalanceAusd);
  let margin = 0;
  let unrealised = 0;
  let unpriced = 0;
  for (const p of positions) {
    margin += cents(p.position.marginAusd);
    if (p.unrealisedPnlAusd === undefined) unpriced += 1;
    else unrealised += cents(p.unrealisedPnlAusd);
  }
  const marginAusd = cents(margin);
  const unrealisedAusd = cents(unrealised);
  const equityAusd = unpriced > 0 ? undefined : cents(freeAusd + marginAusd + unrealisedAusd);
  const depositedAusd = cents(profile.depositedAusd);
  const withdrawnAusd = cents(profile.withdrawnAusd);
  const netInAusd = cents(depositedAusd - withdrawnAusd);
  return {
    freeAusd,
    marginAusd,
    unrealisedAusd,
    equityAusd,
    positions: positions.length,
    unpriced,
    depositedAusd,
    withdrawnAusd,
    netInAusd,
    sinceFirstDepositAusd: equityAusd === undefined ? undefined : cents(equityAusd - netInAusd),
  };
}
