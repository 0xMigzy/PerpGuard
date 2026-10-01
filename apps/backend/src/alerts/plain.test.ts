/**
 * The plain voice: money first and in bold, floors for holdings and ceilings
 * for needs, never a negative percentage, never the word "safe", and every
 * watched message saying how old its numbers are and that it has no buttons.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, esc, freeVerdict, money, renderWatchAlertHtml, shortDistance, watchedPositionLines, wholeAusd } from './plain.ts';
import { buildMessage } from './render.ts';
import { DEFAULT_ALERT_CONFIG } from './types.ts';
import { BTC, FIXTURE_BTC, FIXTURE_BTC_MARK, assessOne } from './testSupport.ts';
import type { RiskAssessment, WatchedScope } from '../risk/types.ts';

const scope: WatchedScope = { accountId: 3388, label: '#3388', indexerBlock: 109_575_809, blocksBehind: 12, indexerState: 'synced' };

function watched(extra: Partial<WatchedScope> = {}, override: Partial<RiskAssessment> = {}): RiskAssessment {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  return { ...change.assessment, topUp: undefined, marginCNS: 2_810_330_000n, watch: { ...scope, sizeUnits: 0.5, toClearDangerCNS: 561_460_000n, ...extra }, ...override };
}

test('money: floors what someone holds, ceils what is needed, groups thousands, bold', () => {
  assert.equal(wholeAusd(1_940_999_999n, 'floor'), '1,940');
  assert.equal(wholeAusd(561_460_000n, 'ceil'), '562');
  assert.equal(wholeAusd(561_000_000n, 'ceil'), '561', 'an exact figure is not bumped');
  assert.equal(money(2_910_000_000n, 'floor'), '<b>2,910 AUSD</b>');
});

test('a negative buffer is words, never a negative percentage', () => {
  assert.equal(distance(-0.014), 'past its closing price');
  assert.equal(shortDistance(-0.014), 'past closing price');
  assert.equal(distance(0.0313), '3.1% from being closed');
});

test('the watch alert leads with the account and position, then money, and says it has no buttons', () => {
  const html = renderWatchAlertHtml(watched({ freeBalanceCNS: 2_910_000_000n }), 'danger', BTC);
  const lines = html.split('\n');
  assert.equal(lines[0], '🔴 <b>#3388 · BTC long is 2.7% from being closed</b>');
  assert.equal(lines[1], 'BTC is 84,007.3. At 81,770.1 the exchange closes this position and they lose the <b>2,810 AUSD</b> behind it.');
  assert.equal(lines[2], 'They hold <b>2,910 AUSD</b> free — enough to survive, if they move it.');
  assert.match(lines[3]!, /^<i>Positions as of block 109,575,809, 12 blocks behind the chain\.<\/i>$/);
  assert.equal(lines[4], 'No buttons. You are watching this account, not holding it.');
  assert.ok(!/safe/i.test(html));
});

test('not enough free balance says what it would take, ceiled; unknown balance claims nothing', () => {
  const short = renderWatchAlertHtml(watched({ freeBalanceCNS: 100_000_000n }), 'danger', BTC);
  assert.match(short, /They hold <b>100 AUSD<\/b> free — not enough: pulling it out of danger takes <b>562 AUSD<\/b>\./);
  const unknown = renderWatchAlertHtml(watched(), 'danger', BTC);
  assert.ok(!unknown.includes('free'), unknown);
});

test('a recovery never says "safe"; past liquidation says "already past"', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const recovered = renderWatchAlertHtml(watched({ freeBalanceCNS: 1n }, { state: 'SAFE', liqBufferPct: 0.092 }), 'recovered', BTC);
  assert.match(recovered.split('\n')[0]!, /^🟢 <b>#3388 · BTC long is 9\.2% from being closed again<\/b>$/);
  assert.ok(!/safe/i.test(recovered));
  assert.ok(!recovered.includes('free'), 'a recovery does not lecture about the balance');
  const past = renderWatchAlertHtml(watched({}, { state: 'PAST_LIQUIDATION', liqBufferPct: -0.01 }), 'past-liquidation', BTC);
  assert.match(past, /is past its closing price/);
  assert.match(past, /already past 81,770\.1/);
  void change;
});

test('blind watch alerts say they cannot see, and still carry freshness and no buttons', () => {
  const html = renderWatchAlertHtml(watched({}, { state: 'POSITIONS_UNTRUSTED' }), 'positions-untrusted', BTC);
  assert.match(html, /^⚪ <b>#3388 · BTC long: I cannot see it right now<\/b>/);
  assert.match(html, /No buttons\./);
});

test('every piece of data is escaped for HTML parse mode', () => {
  assert.equal(esc('A<B & C>'), 'A&lt;B &amp; C&gt;');
  const html = renderWatchAlertHtml(watched({}, { symbol: 'X<Y' }), 'danger', BTC);
  assert.ok(html.includes('X&lt;Y long') && !html.includes('X<Y'));
});

test('buildMessage attaches the HTML to a watched alert only, never to a view or an owner alert', () => {
  const ctx = { alerts: DEFAULT_ALERT_CONFIG, market: BTC };
  assert.ok(buildMessage(watched(), 'danger', ctx).html?.startsWith('🔴'));
  assert.equal(buildMessage(watched(), 'danger', { ...ctx, snapshot: true }).html, undefined);
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  assert.equal(buildMessage(change.assessment, 'danger', ctx).html, undefined);
});

test('the wallet screen lines put money last and in bold; the verdict sums the need across positions', () => {
  const a = watched({ freeBalanceCNS: 2_910_000_000n });
  assert.deepEqual(watchedPositionLines(a, BTC), [
    '🔴 <b>BTC long</b> · 0.5 BTC',
    'Price now 84,007.3',
    'Closed out at 81,770.1 · 2.7% from being closed',
    'They would lose <b>2,810 AUSD</b>',
  ]);
  assert.match(freeVerdict(a.watch, [a]), /^They are holding more than enough to survive this: pulling it out of danger takes <b>562 AUSD<\/b>\./);
  assert.match(freeVerdict({ ...a.watch!, freeBalanceCNS: 600_000_000n }, [a, a]), /^That is not enough to pull those 2 out of danger, which takes <b>1,123 AUSD<\/b>/);
  const clear = { ...a, watch: { ...a.watch!, toClearDangerCNS: 0n } };
  assert.match(freeVerdict(a.watch, [a, clear]), /pulling BTC long out of danger takes <b>562 AUSD<\/b>/, 'one of two needs it: named, not "them"');
  assert.match(freeVerdict({ ...a.watch!, toClearDangerCNS: 0n }, [{ ...a, watch: { ...a.watch!, toClearDangerCNS: 0n } }]), /^Perpl keeps each position's money separate/);
  assert.match(freeVerdict(undefined, [a]), /cannot see their free balance/);
});

test('a balance under one AUSD is "under 1 AUSD", never a floored "0 AUSD"; an empty one says so', () => {
  assert.match(renderWatchAlertHtml(watched({ freeBalanceCNS: 300_000n }), 'danger', BTC), /They hold <b>under 1 AUSD<\/b> free — not enough/);
  assert.match(renderWatchAlertHtml(watched({ freeBalanceCNS: 0n }), 'danger', BTC), /They hold no free AUSD to move: pulling it out of danger takes <b>562 AUSD<\/b>\./);
});
