/**
 * The owner's recorded-session findings, pinned: every tap is described for
 * the log without its token, and Auto armed inside the line offers a choice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RiskAssessment } from '@perpguard/backend/risk';
import { describeTap } from './bot.ts';
import { encodeCallback } from './callback.ts';
import { encodeNav } from './nav.ts';
import { rescueReviewScreen, type RescueDraft } from './rescue.ts';

test('THE TAP LOG names the screen or the action, and NEVER carries the token', () => {
  assert.equal(describeTap(encodeNav({ to: 'kill-stop' })), 'screen kill-stop');
  assert.equal(describeTap(encodeNav({ to: 'rescue-stop', marketId: 2 }, { fresh: true })), 'screen rescue-stop (marketId 2), new message');
  const data = encodeCallback({ kind: 'act', token: 'abcd1234', marketId: 16, amountCNS: 100_000_000n });
  const line = describeTap(data);
  assert.equal(line, 'action act on market 16, amount 100000000 (micros)');
  assert.ok(!line.includes('abcd1234'), 'the token never reaches the log');
  assert.equal(describeTap('garbage'), 'an unreadable button');
});

const draft: RescueDraft = { marketId: 16, collateralDecimals: 6, positionId: 1, triggerPct: 0.05, amountCNS: 100_000_000n, maxRescues: 2, maxTotalCNS: undefined, minRemainingCNS: 0n, cooldownMs: 900_000 };
const at = (buffer: number) => ({ marketId: 16, symbol: 'ETH', side: 'long', positionId: 1, liqBufferPct: buffer }) as unknown as RiskAssessment;
const labels = (s: { buttons: readonly (readonly { text: string }[])[] }) => s.buttons.flat().map((b) => b.text);

test('ARMED AT THE LINE: inside the alert distance the review offers "add now" and "from the next crossing", never a bare TURN ON', () => {
  const inside = rescueReviewScreen(at(0.033), draft, { stopped: false, free: 10_000_000_000n });
  assert.match(inside.html, /It is already inside that distance\.<\/b> Choose: add <b>100 AUSD<\/b> now, or wait/);
  assert.ok(labels(inside).includes('🟢 Turn on · add 100 AUSD now'));
  assert.ok(labels(inside).includes('🟢 Turn on · from the next crossing'));
  assert.ok(!labels(inside).includes('🟢 TURN ON AUTO'));
  const outside = rescueReviewScreen(at(0.09), draft, { stopped: false, free: 10_000_000_000n });
  assert.deepEqual(labels(outside).filter((t) => t.startsWith('🟢')), ['🟢 TURN ON AUTO']);
});
