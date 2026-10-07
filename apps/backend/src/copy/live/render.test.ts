import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCopy } from './render.ts';
import type { CopyLeg, CopyRule } from './store.ts';

const rule = { id: 1, followerAccountId: 710, leaderAccountId: 4532, keepFreeCNS: 0n, enabled: true, pausedReason: undefined, startedAtMs: 0, armedBy: 7, armedChat: 7, armedAtMs: 0, armProof: 'x', lastNotice: undefined } as CopyRule;
const leg = { ruleId: 1, leaderKey: 'k', leaderMarketId: 1, symbol: 'MON', side: 'long', leaderOpenedAtMs: 0, status: 'closed', reason: undefined, actingMarketId: 64, sizeLNS: 5n, leverageHundredths: 200, positionId: 1, openKey: 'o', closeKey: 'c', openedAtMs: 0, closedAtMs: 0 } as CopyLeg;
const opts = { collateralDecimals: 6, sizeDecimalsOf: () => 0 };

test('a closed copy’s result: under one AUSD in words, a loss rounded away from zero', () => {
  assert.match(renderCopy({ kind: 'closed', rule, leg, resultCNS: 300_000n }, opts).html, /at about <b>a gain of under 1 AUSD<\/b>/);
  assert.match(renderCopy({ kind: 'closed', rule, leg, resultCNS: -64_800_000n }, opts).html, /at about <b>−65 AUSD<\/b>/);
});

test('every copy message carries the rule and a one-tap stop; an unknown says nothing is sent again', () => {
  const copied = renderCopy({ kind: 'copied', rule, leg: { ...leg, status: 'open' }, marginCNS: 64_925n, leverageCapped: false, partial: false }, opts);
  assert.match(copied.html, /PerpGuard copies when they open and when they close, not every adjustment in between\./);
  assert.ok(copied.buttons.includes('stop'));
  const unknown = renderCopy({ kind: 'unknown', rule, leg, what: 'open' }, opts);
  assert.match(unknown.html, /Nothing will be sent again for it\./);
  assert.doesNotMatch(unknown.html, /failed/i);
});
