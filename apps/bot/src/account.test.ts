import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIGS, dangerAssessment } from './testSupport.ts';
import { positionsScreen } from './account.ts';
import type { RiskAssessment } from '@perpguard/backend/risk';

const base = dangerAssessment();
const at = (bufferPct: number, over: Partial<RiskAssessment> = {}): RiskAssessment => ({ ...base, liqBufferPct: bufferPct, state: bufferPct < 0 ? 'PAST_LIQUIDATION' : bufferPct < 0.03 ? 'DANGER' : bufferPct < 0.08 ? 'WATCH' : 'SAFE', ...over });
const screen = (assessments: RiskAssessment[]) =>
  positionsScreen({ accountId: 710, assessments, feed: { state: 'connected', reconnectAttempt: 0 }, positions: { state: 'live', lastUpdateMs: 1, ageMs: 0 }, free: { known: true, floorCNS: 10_000_000_000n }, configs: CONFIGS });

test('MY POSITIONS: one button per position, closest to liquidation first, the distance on it; past liquidation in words', () => {
  const s = screen([at(0.2, { marketId: base.marketId }), at(0.027), at(0.05), at(-0.004)]);
  assert.equal(s.html, '📊 <b>MY POSITIONS</b> · testnet #710');
  assert.deepEqual(s.buttons.flat().map((b) => b.text), ['🔴 BTC long · past liquidation', '🔴 BTC long · 2.7%', '🟡 BTC long · 5.0%', '🟢 BTC long · 20.0%', '← Back']);
  assert.doesNotMatch(s.buttons.flat().map((b) => b.text).join(' '), /-0\./, 'never a negative percentage');
});

test('MY POSITIONS: a blind position shows no figure at all; every position has its button, however many', () => {
  const blind = screen([{ ...base, state: 'FEED_DOWN' }]);
  assert.deepEqual(blind.buttons.flat().map((b) => b.text), ["⚪ BTC long · can't see", '← Back']);
  const many = screen(Array.from({ length: 11 }, (_, i) => at(0.02 + i * 0.01, { marketId: 100 + i })));
  assert.equal(many.buttons.length, 11 + 1);
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
