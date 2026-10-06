import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIGS, dangerAssessment } from './testSupport.ts';
import { POSITIONS_SHOWN, bandOf, positionCard, positionsScreen } from './account.ts';
import type { RiskAssessment } from '@perpguard/backend/risk';

const base = dangerAssessment();
const at = (bufferPct: number, over: Partial<RiskAssessment> = {}): RiskAssessment => ({ ...base, liqBufferPct: bufferPct, state: bufferPct < 0 ? 'PAST_LIQUIDATION' : bufferPct < 0.03 ? 'DANGER' : bufferPct < 0.08 ? 'WATCH' : 'SAFE', ...over });
const screen = (assessments: RiskAssessment[]) =>
  positionsScreen({ accountId: 710, assessments, feed: { state: 'connected', reconnectAttempt: 0 }, positions: { state: 'live', lastUpdateMs: 1, ageMs: 0 }, free: { known: true, floorCNS: 10_000_000_000n }, configs: CONFIGS });

test('PHASE 14: closest to liquidation first; each card leads with its distance in bold, then its band', () => {
  const html = screen([at(0.2, { marketId: base.marketId }), at(0.027), at(0.05)]).html;
  const leads = [...html.matchAll(/^(🔴|🟠|🟢) <b>([^<]+)<\/b> · BTC long · (\w+)/gm)].map((m) => `${m[2]} ${m[3]}`);
  assert.deepEqual(leads, ['2.7% from liquidation DANGER', '5.0% from liquidation WATCH', '20.0% from liquidation OK']);
  assert.doesNotMatch(html, /\bsafe\b/i, 'the calm band is OK, never "safe"');
});

test('PHASE 14: every card carries size, value, leverage, margin, PnL, mark and liquidation price, in that order', () => {
  const card = positionCard(base, CONFIGS.get(base.marketId)).join('\n');
  assert.match(card, /^🔴 <b>2\.7% from liquidation<\/b> · BTC long · DANGER\n   Size 0\.5 BTC · value <b>42,003 AUSD<\/b> · <b>14\.9x<\/b>\n   Margin <b>2,810 AUSD<\/b> · PnL <b>−11 AUSD<\/b>\n   Mark 84,007\.3 · liquidation price 81,770\.1$/);
});

test('PHASE 14: past liquidation is said in words, never as a negative percentage; a blind position shows no figure at all', () => {
  const past = positionCard(at(-0.004), CONFIGS.get(base.marketId))[0]!;
  assert.match(past, /^🔴 <b>past its liquidation price<\/b> · BTC long · PAST LIQUIDATION$/);
  assert.doesNotMatch(past, /-0\./);
  const blind = positionCard({ ...base, state: 'FEED_DOWN' }, CONFIGS.get(base.marketId));
  assert.deepEqual(blind, ['⚪ <b>cannot see right now</b> · BTC long · CANNOT SEE'], 'no stale price, size or PnL dressed as current');
  assert.equal(bandOf('POSITIONS_UNTRUSTED'), 'CANNOT SEE');
});

test(`PHASE 14: at most ${POSITIONS_SHOWN} cards, the rest counted; every position still has its button`, () => {
  const many = Array.from({ length: 11 }, (_, i) => at(0.02 + i * 0.01, { marketId: 100 + i }));
  const s = screen(many);
  assert.equal([...s.html.matchAll(/ from liquidation<\/b>/g)].length, POSITIONS_SHOWN);
  assert.match(s.html, /And 3 more, all further from liquidation/);
  assert.equal(s.buttons.length, 11 + 1);
  assert.ok(s.html.length < 4_096, `fits in one Telegram message (${s.html.length})`);
});

test('THE sr 32 OUTCOME: success first, then the disagreement in words, never "failed" or "rejection", and do not send it again', async () => {
  const { outcomeScreen } = await import('./account.ts');
  const market = CONFIGS.get(base.marketId)!;
  const action = { type: 'add-margin' as const, intent: 'custom' as const, marketId: base.marketId, symbol: 'BTC', positionId: 1, amountCNS: 100_000_000n, label: 'x' };
  const html = outcomeScreen({ action, market, assessment: base, outcome: { kind: 'applied', detail: 'done', venueRejected: true } } as never).html;
  assert.match(html, /^✓ <b>Added 100 AUSD to BTC long<\/b>/);
  assert.match(html, /\n\nThe exchange's own report disagreed with what actually happened\.\nThe margin applied — I checked the position itself, not the receipt\.\n<b>Do not send it again\.<\/b>$/);
  assert.doesNotMatch(html, /failed|rejection|rejected/i);
});
