/**
 * ONE ACCOUNT'S EQUITY, THE TRADER PAGE'S WAY (12 Oct 2026), for the bot's
 * /equity reply. The same three reads the page makes, in the same order:
 *
 *   1. the profile `/api/analytics/account/:id` serves (the cached one);
 *   2. its open positions priced as `/account/:id/positions` prices them
 *      (the analytics venue's marks, read now);
 *   3. `accountSummary`, the page's own function, over the two.
 *
 * Nothing is computed here: an account the index does not hold is said so,
 * and a position with no mark leaves equity withheld, as on the page.
 */
import { accountSummary, type AccountSummary, type AssessedPositions, type WalletProfile } from '@perpguard/shared';

export type AccountEquity =
  | {
      readonly kind: 'ok';
      readonly accountId: number;
      readonly summary: AccountSummary;
      /** The OLDEST mark used, as the positions route reports it. Undefined with no priced position. */
      readonly marksAsOfMs: number | undefined;
    }
  | { readonly kind: 'unknown-account'; readonly accountId: number };

export interface AccountEquityDeps {
  /** The profile the trader page is served. Undefined: the index holds no such account. */
  readonly profile: (accountId: number) => Promise<WalletProfile | undefined>;
  /** The positions route's own pricing. */
  readonly assess: (positions: WalletProfile['openPositions']) => Promise<AssessedPositions>;
}

export async function readAccountEquity(deps: AccountEquityDeps, accountId: number): Promise<AccountEquity> {
  const profile = await deps.profile(accountId);
  if (profile === undefined) return { kind: 'unknown-account', accountId };
  const assessed = await deps.assess(profile.openPositions);
  return { kind: 'ok', accountId, summary: accountSummary(profile, assessed.positions), marksAsOfMs: assessed.asOfMs };
}
