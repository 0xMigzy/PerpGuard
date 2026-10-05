import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchBinanceFunding,
  fundingAprPct,
  measuredIntervalSec,
  parseBinanceFunding,
  parseHyperliquidFunding,
  venueCell,
} from './external-funding.ts';

// Real payloads, captured from the VPS on 5 Oct 2026 and trimmed.
const fixture = JSON.parse(readFileSync(new URL('../../../../fixtures/funding-venues-2026-10-05.json', import.meta.url), 'utf8'));

test('hyperliquid: the hourly rate, a 1 h interval, the documented interest; delisted coins dropped', () => {
  const s = parseHyperliquidFunding(fixture.hyperliquid.response);
  const btc = s.quotes.find((q) => q.ticker === 'BTC')!;
  assert.equal(btc.ratePct, 0.00125);
  assert.equal(btc.intervalSec, 3600);
  assert.equal(btc.intervalSource, 'stated');
  assert.equal(btc.markPrice, 85811);
  assert.equal(s.quotes.some((q) => q.ticker === 'MATIC'), false, 'MATIC is delisted on Hyperliquid');
  // 0.00125% an hour is the interest term alone: 10.95% a year.
  assert.equal(fundingAprPct(btc.ratePct, btc.intervalSec)!.toFixed(2), '10.95');
});

test('binance: per-symbol interval from fundingInfo, the served interest rate, USDT book only', () => {
  const s = parseBinanceFunding(fixture.binance.premiumIndex, fixture.binance.fundingInfo);
  const by = Object.fromEntries(s.quotes.map((q) => [q.instrument, q]));
  assert.equal(by.BTCUSDT!.intervalSec, 8 * 3600);
  assert.equal(by.MONUSDT!.intervalSec, 4 * 3600);
  assert.equal(by.MONUSDT!.ratePct, 0.005, 'a quiet 4 h symbol pays the interest scaled to its interval');
  assert.equal(by.BTCUSDT!.interestPctPer8h, 0.01);
  assert.equal(by.ETHUSDC, undefined, 'USDC-margined books are not compared');
  assert.equal(by.MONUSDT!.ticker, 'MON');
  // 0.005% per 4 h is 10.95% a year: the same interest term as an 8 h symbol.
  assert.equal(fundingAprPct(by.MONUSDT!.ratePct, by.MONUSDT!.intervalSec)!.toFixed(2), '10.95');
});

test('binance: a symbol fundingInfo does not list is never assumed to be 8 h', () => {
  const absent = fixture.binance.premiumIndex.find((r: { symbol: string }) => !fixture.binance.fundingInfo.some((i: { symbol: string }) => i.symbol === r.symbol));
  const unmeasured = parseBinanceFunding(fixture.binance.premiumIndex, fixture.binance.fundingInfo).quotes.find((q) => q.instrument === absent.symbol)!;
  assert.equal(unmeasured.intervalSec, undefined);
  assert.equal(unmeasured.intervalSource, undefined);
  const measured = parseBinanceFunding(fixture.binance.premiumIndex, fixture.binance.fundingInfo, new Map([[absent.symbol, 14_400]])).quotes.find((q) => q.instrument === absent.symbol)!;
  assert.equal(measured.intervalSec, 14_400);
  assert.equal(measured.intervalSource, 'measured');
});

test('binance fetch: measures only wanted tickers fundingInfo does not list', async () => {
  const absent = fixture.binance.premiumIndex.find((r: { symbol: string }) => !fixture.binance.fundingInfo.some((i: { symbol: string }) => i.symbol === r.symbol));
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    const body = url.includes('premiumIndex')
      ? fixture.binance.premiumIndex
      : url.includes('fundingInfo')
        ? fixture.binance.fundingInfo
        : [0, 1, 2, 3].map((i) => ({ fundingTime: 1_791_000_000_000 + i * 14_400_000 }));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const s = await fetchBinanceFunding(['BTC', absent.symbol.replace('USDT', ''), 'NOPE'], { fetchImpl });
  assert.equal(asked.filter((u) => u.includes('fundingRate')).length, 1, 'BTC is listed, NOPE does not exist');
  assert.equal(s.quotes.find((q) => q.instrument === absent.symbol)!.intervalSource, 'measured');
});

test('identity: matched on the ticker in any case, confirmed by price; a ticker with another price is another asset', () => {
  const hl = parseHyperliquidFunding(fixture.hyperliquid.response).quotes;
  const lit = venueCell('lit', 4.04044, hl);
  assert.equal(lit.kind, 'quote');
  assert.deepEqual(venueCell('LIT', 0.9, hl), { kind: 'different-asset', instrument: 'LIT', markPrice: 4.047798 });
  assert.deepEqual(venueCell('PEPE', 0.00001, hl), { kind: 'not-listed' }, 'kPEPE is a 1000x contract, not PEPE');
  if (lit.kind !== 'quote') return;
  assert.equal(lit.interestAprPct.toFixed(2), '10.95');
});

test('measured interval is the median gap', () => {
  assert.equal(measuredIntervalSec([0, 3_600_000, 7_200_000, 7_300_000]), 3600);
  assert.equal(measuredIntervalSec([5]), undefined);
});

test('parsers refuse a payload of the wrong shape rather than reading it as "nothing listed"', () => {
  assert.throws(() => parseHyperliquidFunding({}), /hyperliquid/);
  assert.throws(() => parseBinanceFunding({}, []), /binance/);
});
