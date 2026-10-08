import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketDailyPoint, MarketDailySeries, MarketOpenInterest } from '@perpguard/shared';
import { oiHistory } from './oiHistory.ts';

const D = (n: number) => Date.UTC(2026, 9, n);
const pt = (dayMs: number, lots: number, markClose: number | undefined): MarketDailyPoint => ({
  dayMs, volumeAusd: 0, tradeCount: 0, feesAusd: 0, liquidationCount: 0, rescuableLiquidationCount: 0,
  openInterestDeltaLots: lots, markOpen: markClose, markHigh: markClose, markLow: markClose, markClose,
});
const market = (marketId: number, symbol: string, points: MarketDailyPoint[]): MarketDailySeries => ({ market: { marketId, symbol, indexerName: symbol }, points });
const venue = (marketId: number, symbol: string, size: number, mark: number, atMs = 5): MarketOpenInterest => ({
  venue: 'perpl', network: 'mainnet', marketId, symbol, openInterestSize: size, markPrice: mark, openInterestNotional: size * mark, atBlock: 1, atMs,
} as MarketOpenInterest);

test('each day is lots × that day\'s close, summed over markets', () => {
  const h = oiHistory(
    [market(1, 'BTC', [pt(D(1), 8, 80_000), pt(D(2), 8.14921, 85_000)]), market(20, 'ETH', [pt(D(2), 190, 2_700)])],
    undefined,
  );
  assert.deepEqual(h.days.map((d) => [d.dayMs, Math.round(d.totalAusd)]), [
    [D(1), 640_000],
    [D(2), Math.round(8.14921 * 85_000 + 190 * 2_700)],
  ]);
  assert.equal(h.days[1]!.byMarket[20], 513_000);
  assert.equal(h.now, undefined, 'no venue reading, no anchor point');
});

test('a day with no mark carries the last close; lots with no mark yet are left out and counted, never priced at 0', () => {
  const h = oiHistory([market(1, 'BTC', [pt(D(1), 2, undefined), pt(D(2), 2, 100), pt(D(3), 3, undefined)])], undefined);
  assert.deepEqual(h.days.map((d) => [d.totalAusd, d.unpriced]), [
    [0, 1],
    [200, 0],
    [300, 0],
  ]);
});

test('the series ends on the venue\'s level now, and history is never shifted to meet it', () => {
  const h = oiHistory([market(1, 'BTC', [pt(D(2), 8.14921, 85_000)])], [venue(1, 'BTC', 8.14836, 85_300, 7), venue(20, 'ETH', 190.032, 2_696, 4)]);
  assert.equal(h.now!.totalAusd, 8.14836 * 85_300 + 190.032 * 2_696);
  assert.equal(h.now!.atMs, 4, 'dated by the oldest reading');
  assert.equal(h.days[0]!.totalAusd, 8.14921 * 85_000, 'unchanged by the anchor');
});


test('THE INFO ICON SAYS WHAT WAS MEASURED: matches to the lot, the largest gap and its cause with both blocks, and how old the check is', async () => {
  const { reconciliationText } = await import('./oiHistory.ts');
  const r = {
    atMs: 1_000_000,
    indexBlock: 111_679_505,
    matched: 9,
    markets: Array.from({ length: 11 }, (_, i) => ({ marketId: i, symbol: `M${i}`, indexedLots: 1, venueLots: 1, gapLots: 0, gapShare: 0, venueBlock: 111_679_431 })),
    largest: { marketId: 10, symbol: 'MON', indexedLots: 2_629_097, venueLots: 2_626_096, gapLots: 3_001, gapShare: 0.001143, venueBlock: 111_679_430 },
  };
  const t = reconciliationText(r, 1_000_000 + 3 * 60_000);
  assert.equal(t.lead, 'Drawn as indexed.');
  assert.equal(t.detail, "Read beside the venue's own figure, the index matches the venue to the lot on 9 of 11 markets. The largest gap is MON, 0.11% (3,001 lots): trades landing between the two reads, the venue's at block 111,679,430 and the index's at 111,679,505. Checked 3 min ago.");
  assert.doesNotMatch(t.detail!, /30%|7 of 11/);
  assert.match(reconciliationText({ ...r, matched: 11, largest: undefined }, 1_000_000).detail!, /on all 11 markets\. Checked under a minute ago\.$/);
  assert.match(reconciliationText(undefined, 0).detail!, /has not run yet/);
  const { gapPct } = await import('./oiHistory.ts');
  assert.equal(gapPct(0.0000352), '0.0035%', 'a real gap never reads 0%');
  assert.equal(gapPct(0.3062), '30.62%');
  assert.equal(gapPct(0), '0%');
});
