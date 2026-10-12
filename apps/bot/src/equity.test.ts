import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountSummary } from '@perpguard/shared';
import { equityHtml } from './equity.ts';

const FRESH = 'Positions come from the mainnet index at block 100; marks come from the venue. Not live, and read-only from this chat.';
const ok = (profile: Parameters<typeof accountSummary>[0], positions: Parameters<typeof accountSummary>[1], marksAsOfMs?: number) =>
  ({ kind: 'ok' as const, accountId: 24, summary: accountSummary(profile, positions), marksAsOfMs });

test('THE PRINTED ARITHMETIC ADDS UP: the three parts, read back off the message, sum to the equity printed', () => {
  const html = equityHtml(ok({ freeBalanceAusd: 101.337, depositedAusd: 0, withdrawnAusd: 0 }, [{ position: { marginAusd: 55.555 }, unrealisedPnlAusd: 7.777 }, { position: { marginAusd: 0.004 }, unrealisedPnlAusd: -20.123 }], 0), { nowMs: 5_000, freshness: FRESH });
  const figures = [...html.matchAll(/<b>([−+]?[\d,]+\.\d\d) AUSD<\/b>/g)].map((m) => Number(m[1]!.replace('−', '-').replace(/[+,]/g, '')));
  const [free, margin, unrealised, total] = figures as [number, number, number, number];
  assert.deepEqual([free, margin, unrealised, total], [101.34, 55.56, -12.34, 144.56]);
  assert.equal(Math.round((free + margin + unrealised) * 100), Math.round(total * 100));
  assert.match(html, /^💰 <b>#24 · equity 144\.56 AUSD<\/b>/, 'the headline is the same total');
});

test('a gain carries a plus, a loss a true minus, and an account with nothing open is its free balance', () => {
  const up = equityHtml(ok({ freeBalanceAusd: 10, depositedAusd: 0, withdrawnAusd: 0 }, [{ position: { marginAusd: 5 }, unrealisedPnlAusd: 2.5 }], 0), { nowMs: 0, freshness: FRESH });
  assert.match(up, /Unrealised P&amp;L: <b>\+2\.50 AUSD<\/b>/);
  assert.match(up, /^💰 <b>#24 · equity 17\.50 AUSD<\/b>/);
  assert.match(up, /1 open position, priced/);
  const flat = equityHtml(ok({ freeBalanceAusd: 7.5, depositedAusd: 0, withdrawnAusd: 0 }, []), { nowMs: 0, freshness: FRESH });
  assert.match(flat, /^💰 <b>#24 · equity 7\.50 AUSD<\/b>/);
  assert.match(flat, /Unrealised P&amp;L: <b>0\.00 AUSD<\/b>/);
  assert.match(flat, /No open positions\. Positions come from the mainnet index/);
});

test('ONE UNPRICED POSITION: equity is not totalled, never a partial sum, and the message says why', () => {
  const html = equityHtml(ok({ freeBalanceAusd: 10, depositedAusd: 0, withdrawnAusd: 0 }, [{ position: { marginAusd: 5 }, unrealisedPnlAusd: 1 }, { position: { marginAusd: 5 } }], 0), { nowMs: 0, freshness: FRESH });
  assert.match(html, /^💰 <b>#24 · equity not totalled<\/b>\n1 of 2 open positions has no price right now, and a partial sum is not equity\./);
  assert.match(html, /Margin in use: <b>10\.00 AUSD<\/b>/);
  assert.match(html, /Unrealised P&amp;L, priced positions only: <b>\+1\.00 AUSD<\/b>/);
  assert.doesNotMatch(html, /Free \+ margin/);
});
