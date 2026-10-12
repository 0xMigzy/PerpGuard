import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountSummary, type AssessedPositions, type WalletProfile } from '@perpguard/shared';
import { accountSummary as pageSummary } from '../../../web/src/lib/traders.ts';
import { readAccountEquity } from './accountEquity.ts';

const profile = (over: Partial<WalletProfile>): WalletProfile => ({ freeBalanceAusd: 4_180.004, depositedAusd: 23_500, withdrawnAusd: 0, openPositions: [], ...over }) as WalletProfile;
const priced = (rows: readonly { marginAusd: number; unrealisedPnlAusd?: number }[]): AssessedPositions =>
  ({ asOfMs: 990_000, positions: rows.map((r) => ({ position: { marginAusd: r.marginAusd }, ...(r.unrealisedPnlAusd === undefined ? {} : { unrealisedPnlAusd: r.unrealisedPnlAusd }) })) }) as unknown as AssessedPositions;

test("THE TRADER PAGE'S OWN FUNCTION: the web's accountSummary IS the shared one, so the bot and the page cannot diverge", () => {
  assert.equal(pageSummary, accountSummary);
});

test('a valid account: the profile the page is served, priced as the positions route prices it, through the page summary', async () => {
  const p = profile({ openPositions: [{}, {}] as unknown as WalletProfile['openPositions'] });
  const rows = [{ marginAusd: 8_000, unrealisedPnlAusd: -1_000.4 }, { marginAusd: 4_450, unrealisedPnlAusd: -283.6 }];
  let assessedWith: unknown;
  const r = await readAccountEquity({ profile: async (id) => (id === 5213 ? p : undefined), assess: async (positions) => { assessedWith = positions; return priced(rows); } }, 5213);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(assessedWith, p.openPositions, "the profile's own open positions are what is priced");
  assert.deepEqual(r.summary, accountSummary(p, priced(rows).positions));
  assert.equal(r.summary.equityAusd, 15_346);
  assert.equal(r.summary.freeAusd + r.summary.marginAusd + r.summary.unrealisedAusd, r.summary.equityAusd);
  assert.equal(r.marksAsOfMs, 990_000);
});

test('an account the index does not hold is unknown, and nothing is priced for it', async () => {
  let assessed = 0;
  const r = await readAccountEquity({ profile: async () => undefined, assess: async () => { assessed += 1; return priced([]); } }, 999_999);
  assert.deepEqual(r, { kind: 'unknown-account', accountId: 999_999 });
  assert.equal(assessed, 0);
});

test('one position without a mark: equity is withheld, as on the page', async () => {
  const r = await readAccountEquity({ profile: async () => profile({}), assess: async () => priced([{ marginAusd: 5, unrealisedPnlAusd: 1 }, { marginAusd: 5 }]) }, 24);
  assert.equal(r.kind === 'ok' && r.summary.equityAusd, undefined);
  assert.equal(r.kind === 'ok' && r.summary.unpriced, 1);
});
