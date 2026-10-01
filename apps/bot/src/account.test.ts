import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killReportScreen } from './account.ts';

test('a partial kill switch says you still have exposure, lists each position, and never invites a second firing', () => {
  const html = killReportScreen({
    closed: ['BTC long'],
    stillOpen: [{ name: 'ETH short', why: 'I will not act while the price feed is down.' }],
    unresolved: [{ name: 'SOL long', nextStep: 'Read this position directly.' }],
    notPriceable: ['TAO long'],
  }).html;
  assert.match(html, /^⚠️ <b>Closed 1 of 4\. You still have exposure\.<\/b>/);
  assert.match(html, /✓ BTC long — closed/);
  assert.match(html, /• ETH short — still open: I will not act while the price feed is down\./);
  assert.match(html, /\? SOL long — not known yet\. Read this position directly\./);
  assert.match(html, /• TAO long — not closed: I cannot price it right now\./);
  assert.match(html, /Do not fire the kill switch again to finish/);
});

test('a refused kill switch sent nothing and says so', () => {
  assert.match(killReportScreen({ refused: 'I cannot see your positions right now.', closed: [], stillOpen: [], unresolved: [], notPriceable: [] }).html, /^<b>Kill switch not fired\.<\/b> I cannot see your positions right now\. Nothing was sent\.$/);
});
