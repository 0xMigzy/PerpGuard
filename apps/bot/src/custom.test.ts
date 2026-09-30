/**
 * The pure half of the custom amount: the prompt's lifetime, the parser, and one
 * message per way of getting the number wrong.
 *
 * The parser tests are the ones that matter most here. A typed amount is the only
 * figure in this product PerpGuard did not compute, so it is the only one that can
 * arrive malformed — and the failure that matters is not a rejected "abc", it is
 * an accepted number that means something other than what was typed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_TTL_MS } from './actions.ts';
import type { FreeBalanceReading } from './balance.ts';
import {
  IMPLAUSIBLE_NOTIONAL_MULTIPLE,
  PendingAmountStore,
  customAction,
  formatCustomAusd,
  parseAusdAmount,
  renderAmountPrompt,
  smallestIncrement,
  validateCustomAmount,
} from './custom.ts';
import { BTC, MON, assessOne, FIXTURE_BTC, FIXTURE_BTC_MARK } from './testSupport.ts';

const KNOWN = (floorCNS: bigint): FreeBalanceReading => ({ known: true, floorCNS });
const UNKNOWN: FreeBalanceReading = { known: false, reason: 'no account snapshot yet.' };

/** The fixture position's notional at the mark: 42,003.65 AUSD. */
const NOTIONAL_CNS = 42_003_650_000n;

const context = (
  overrides: Partial<Parameters<typeof validateCustomAmount>[1]> = {},
): Parameters<typeof validateCustomAmount>[1] => ({
  market: BTC,
  freeBalance: KNOWN(10_000_000_000n),
  notionalCNS: NOTIONAL_CNS,
  ...overrides,
});

// ── the pending prompt ──────────────────────────────────────────────────────

test('a prompt expires on the same rule as an action token', () => {
  // Not "after fifteen minutes" — after the SAME fifteen minutes, off the same
  // constant. An amount typed against a mark that has since moved is a wrong
  // number, which is exactly why the token behind a button expires too.
  const clock = { nowMs: 1_000_000 };
  const store = new PendingAmountStore({ now: () => clock.nowMs });
  store.put({ userId: 'u', telegramUserId: 7, marketId: 1, symbol: 'BTC', positionId: 42 });

  clock.nowMs += ACTION_TTL_MS - 1;
  assert.equal(store.get(7)?.marketId, 1, 'still live one millisecond short of the TTL');

  clock.nowMs += 1;
  assert.equal(store.get(7), undefined, 'gone exactly at the TTL');
  assert.equal(store.size, 0, 'and swept, not merely hidden');
});

test('a prompt is scoped to the position it was opened against', () => {
  const store = new PendingAmountStore({ now: () => 1_000_000 });
  store.put({ userId: 'u', telegramUserId: 7, marketId: 1, symbol: 'BTC', positionId: 42 });
  const pending = store.get(7);
  assert.equal(pending?.marketId, 1);
  assert.equal(pending?.symbol, 'BTC');
  assert.equal(pending?.positionId, 42);
});

test('a second prompt replaces the first rather than queueing beside it', () => {
  // One reply cannot answer two questions, and picking one of them would be
  // guessing which position the collateral is for.
  const store = new PendingAmountStore({ now: () => 1_000_000 });
  store.put({ userId: 'u', telegramUserId: 7, marketId: 1, symbol: 'BTC', positionId: 42 });
  store.put({ userId: 'u', telegramUserId: 7, marketId: 20, symbol: 'ETH', positionId: 77 });

  assert.equal(store.size, 1);
  assert.equal(store.get(7)?.symbol, 'ETH');
});

test('prompts are per user, so one trader’s reply cannot answer another’s question', () => {
  const store = new PendingAmountStore({ now: () => 1_000_000 });
  store.put({ userId: 'a', telegramUserId: 7, marketId: 1, symbol: 'BTC', positionId: 42 });
  store.put({ userId: 'b', telegramUserId: 8, marketId: 20, symbol: 'ETH', positionId: 77 });

  assert.equal(store.get(7)?.symbol, 'BTC');
  assert.equal(store.get(8)?.symbol, 'ETH');
});

test('cancelling clears the prompt', () => {
  const store = new PendingAmountStore({ now: () => 1_000_000 });
  store.put({ userId: 'u', telegramUserId: 7, marketId: 1, symbol: 'BTC', positionId: 42 });
  store.delete(7);
  assert.equal(store.get(7), undefined);
});

// ── formatting ─────────────────────────────────────────────────────────────

test('an exact amount renders grouped, with no trailing zeros and no float', () => {
  assert.equal(formatCustomAusd(562_000_000n, 6), '562');
  assert.equal(formatCustomAusd(1_000_500_000n, 6), '1,000.5');
  assert.equal(formatCustomAusd(1n, 6), '0.000001');
  assert.equal(formatCustomAusd(0n, 6), '0');
  assert.equal(formatCustomAusd(42_003_650_000n, 6), '42,003.65');
  // Past what a float holds exactly: 2^53 micros and a bit.
  assert.equal(formatCustomAusd(9_007_199_254_740_993n, 6), '9,007,199,254.740993');
  // A market whose collateral had different precision would quote differently,
  // and nothing here assumes six places.
  assert.equal(formatCustomAusd(1_500n, 3), '1.5');
  assert.equal(formatCustomAusd(1_500n, 0), '1,500');
});

test('the smallest increment comes from the market, never from a constant', () => {
  assert.equal(smallestIncrement(BTC), '0.000001');
  assert.equal(smallestIncrement({ ...BTC, collateralDecimals: 2 }), '0.01');
  assert.equal(smallestIncrement({ ...BTC, collateralDecimals: 0 }), '1');
});

// ── parsing ────────────────────────────────────────────────────────────────

test('a typed amount parses to exact micros, integer all the way', () => {
  const cases: ReadonlyArray<readonly [string, bigint]> = [
    ['1000', 1_000_000_000n],
    ['1000.5', 1_000_500_000n],
    [' 250 ', 250_000_000n],
    ['+250', 250_000_000n],
    ['.5', 500_000n],
    ['0.000001', 1n],
    ['0.0000010', 1n], // a trailing zero carries no value
    ['1000.', 1_000_000_000n],
    // OUR OWN OUTPUT. "Add 2,662 → ..." is what the alert printed, so the most
    // likely custom amount in the world is one copied off it.
    ['2,662', 2_662_000_000n],
    ['1,000.07', 1_000_070_000n],
  ];
  for (const [input, expected] of cases) {
    const parsed = parseAusdAmount(input, 6);
    assert.ok(parsed.ok, `${JSON.stringify(input)} should parse`);
    assert.equal(parsed.amountCNS, expected, JSON.stringify(input));
  }
});

test('0.07 does not pick up a float’s error on the way in', () => {
  // Number('1000.07') * 1e6 is 1000069999.9999999. The parser never multiplies.
  const parsed = parseAusdAmount('1000.07', 6);
  assert.ok(parsed.ok);
  assert.equal(parsed.amountCNS, 1_000_070_000n);
});

test('anything that is not a plain decimal is refused rather than guessed at', () => {
  for (const input of ['', 'abc', '/positions', '1e3', '$100', '100 AUSD', '1.2.3', '--5', '1/2']) {
    const parsed = parseAusdAmount(input, 6);
    assert.equal(parsed.ok, false, `${JSON.stringify(input)} should not parse`);
    assert.ok(!parsed.ok);
    assert.equal(parsed.code, 'not-a-number', JSON.stringify(input));
  }
});

test('a negative amount is named for what it is, not called unreadable', () => {
  for (const input of ['-5', '-0.5']) {
    const parsed = parseAusdAmount(input, 6);
    assert.ok(!parsed.ok);
    assert.equal(parsed.code, 'not-positive');
  }
});

test('zero in any spelling is not positive', () => {
  for (const input of ['0', '0.0', '0.000000', '.0']) {
    const parsed = parseAusdAmount(input, 6);
    assert.ok(!parsed.ok);
    assert.equal(parsed.code, 'not-positive', JSON.stringify(input));
  }
});

test('an amount below one increment is refused, and one finer than it separately', () => {
  const below = parseAusdAmount('0.0000004', 6);
  assert.ok(!below.ok);
  assert.equal(below.code, 'below-increment');

  const finer = parseAusdAmount('1.0000004', 6);
  assert.ok(!finer.ok);
  assert.equal(finer.code, 'finer-than-increment');
});

test('an amount too large for a button is refused rather than throwing in the handler', () => {
  // encodeCallback throws above 64 bytes — correctly, since a truncated payload
  // would decode to a different amount — so it has to be caught here.
  const parsed = parseAusdAmount('9'.repeat(40), 6);
  assert.ok(!parsed.ok);
  assert.equal(parsed.code, 'too-large');
});

// ── validation ─────────────────────────────────────────────────────────────

test('each way of getting it wrong gets its own message, and each says what to do', () => {
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ['abc', /I need a number of AUSD, and “abc” is not one/],
    ['-5', /has to be more than zero/],
    ['0', /has to be more than zero/],
    ['0.0000004', /smaller than the smallest amount BTC collateral can take.+0\.000001 AUSD/s],
    ['1.0000004', /smallest increment is 0\.000001 AUSD and “1\.0000004” is finer than that/],
    ['9'.repeat(40), /larger number than I can put in a button/],
  ];
  for (const [input, pattern] of cases) {
    const verdict = validateCustomAmount(input, context());
    assert.equal(verdict.ok, false, JSON.stringify(input));
    assert.ok(!verdict.ok);
    assert.match(verdict.message, pattern);
    assert.match(verdict.message, /\/cancel/, `${JSON.stringify(input)} must offer a way out`);
  }
});

test('a finer-than-increment amount is handed back, never silently rounded', () => {
  // The computed options CEIL, because PerpGuard chose their amounts. This one is
  // the user's, and adjusting it would mean the figure they confirm is not the
  // figure they typed.
  const verdict = validateCustomAmount('1.0000004', context());
  assert.ok(!verdict.ok);
  assert.match(verdict.message, /I will not round it for you/);
});

test('an amount over the free-balance floor WARNS and still goes through', () => {
  // Our figure is b - lb, which can understate the real balance. Blocking a
  // legitimate rescue because our own number was conservative is worse than
  // letting a genuinely short request be rejected by the venue.
  const verdict = validateCustomAmount('11000', context({ freeBalance: KNOWN(10_000_000_000n) }));
  assert.ok(verdict.ok, 'must not refuse');
  assert.equal(verdict.amountCNS, 11_000_000_000n);
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0]!, /may be more than your free balance/);
  assert.match(verdict.warnings[0]!, /at least 10,000 AUSD available/);
  // "At least", and said to be a floor. Never "you have".
  assert.match(verdict.warnings[0]!, /floor rather than your balance/);
  assert.doesNotMatch(verdict.warnings[0]!, /you have/);
});

test('an amount inside the floor gets no warning at all', () => {
  const verdict = validateCustomAmount('9000', context({ freeBalance: KNOWN(10_000_000_000n) }));
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.warnings, []);
});

test('an unknown balance says so rather than implying it was checked', () => {
  const verdict = validateCustomAmount('9000', context({ freeBalance: UNKNOWN }));
  assert.ok(verdict.ok);
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0]!, /could not check your free balance: no account snapshot yet\./);
});

test('an implausibly large amount is asked about, not refused', () => {
  const tenX = IMPLAUSIBLE_NOTIONAL_MULTIPLE * NOTIONAL_CNS;
  const under = validateCustomAmount(formatCustomAusd(tenX, 6), context({ freeBalance: KNOWN(tenX) }));
  assert.ok(under.ok);
  assert.deepEqual(under.warnings, [], 'exactly 10x is not yet implausible');

  const over = validateCustomAmount(
    formatCustomAusd(tenX + 1n, 6),
    context({ freeBalance: KNOWN(tenX + 1n) }),
  );
  assert.ok(over.ok, 'must not refuse — the user is asked to confirm they meant it');
  assert.equal(over.amountCNS, tenX + 1n);
  assert.equal(over.warnings.length, 1);
  assert.match(over.warnings[0]!, /more than 10x this position's whole size at the mark/);
  assert.match(over.warnings[0]!, /42,003\.65 AUSD/);
  assert.match(over.warnings[0]!, /Confirm only if you meant it/);
});

test('both warnings can apply at once, and neither is a refusal', () => {
  const verdict = validateCustomAmount('5000000', context({ freeBalance: KNOWN(1_000_000n) }));
  assert.ok(verdict.ok);
  assert.equal(verdict.warnings.length, 2);
});

// ── the prompt's words ─────────────────────────────────────────────────────

test('the prompt names the position, restates where it stands, and offers a way out', () => {
  const text = renderAmountPrompt({
    symbol: 'BTC',
    side: 'long',
    market: BTC,
    freeBalance: KNOWN(12_480_000_000n),
    bufferPct: 0.026631,
    liquidationPricePNS: 817_701n,
    markPricePNS: 840_073n,
    notionalCNS: NOTIONAL_CNS,
    bufferDecimals: 1,
  });

  assert.equal(
    text,
    [
      'Custom amount — add margin to BTC long',
      'Now: buffer 2.7%, liquidation 81,770.1, mark 84,007.3.',
      'Position size at the mark: 42,003.65 AUSD.',
      'At least 12,480 AUSD free — a floor, not your balance.',
      'Reply with an amount in AUSD and I will show you the buffer and liquidation price it buys.',
      'Smallest increment 0.000001 AUSD. /cancel to drop this.',
      'Nothing has been sent, and nothing will be until you confirm.',
    ].join('\n'),
  );
});

test('the prompt renders a position past liquidation in words, not as a negative percentage', () => {
  const text = renderAmountPrompt({
    symbol: 'BTC',
    side: 'short',
    market: BTC,
    freeBalance: UNKNOWN,
    bufferPct: -0.014,
    liquidationPricePNS: 817_701n,
    markPricePNS: 840_073n,
    notionalCNS: NOTIONAL_CNS,
    bufferDecimals: 1,
  });
  assert.match(text, /^Custom amount — add margin to BTC short$/m);
  assert.match(text, /Now: past liquidation,/);
  assert.doesNotMatch(text, /-1\.4%/);
  assert.match(text, /could not check your free balance/);
});

test('the prompt renders each market at its own precision', () => {
  // MON prices carry six decimal places. A hard-coded precision would look right
  // on BTC and be wrong here.
  const text = renderAmountPrompt({
    symbol: 'MON',
    side: 'long',
    market: MON,
    freeBalance: KNOWN(1_000_000n),
    bufferPct: 0.0276,
    liquidationPricePNS: 48_620n,
    markPricePNS: 50_000n,
    notionalCNS: 500_000_000n,
    bufferDecimals: 1,
  });
  assert.match(text, /liquidation 0\.048620, mark 0\.050000\./);
  assert.match(text, /At least 1 AUSD free/);
});

// ── the action a custom amount becomes ─────────────────────────────────────

test('a custom amount is priced by the risk engine, in the offered options’ own shape', () => {
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const projected = harness.loop.projectAddMargin(BTC.marketId, 1_000_000_000n);
  assert.ok(projected.ok);

  const action = customAction(projected.projection, BTC, 4242, 1);
  assert.equal(action.label, 'Add 1,000 → buffer 5.0%, liquidation 79,770.1');
  assert.equal(action.intent, 'custom');
  assert.equal(action.type, 'add-margin');
  assert.equal(action.marketId, BTC.marketId);
  assert.equal(action.positionId, 4242);
  // NOT CEILED. The label and the amount are the same figure, because the figure
  // came from the user and was already exact.
  assert.equal(action.amountCNS, 1_000_000_000n);
  assert.match(action.label, /Add 1,000 →/);
});

test('a fractional custom amount keeps its own precision in the label', () => {
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const projected = harness.loop.projectAddMargin(BTC.marketId, 250_500_000n);
  assert.ok(projected.ok);
  const action = customAction(projected.projection, BTC, 4242, 1);
  assert.equal(action.label, 'Add 250.5 → buffer 3.3%, liquidation 81,269.1');
  assert.equal(action.amountCNS, 250_500_000n);
});

test('an amount too small to rescue a doomed position says so, not "buffer -1.4%"', () => {
  // Unreachable from the two computed options, which reach a positive buffer by
  // construction. Entirely reachable once the user picks the number.
  const { harness } = assessOne(
    { ...FIXTURE_BTC, margin: 1_000 },
    // A mark far below the liquidation price of a thinly margined long.
    70_000,
  );
  const projected = harness.loop.projectAddMargin(BTC.marketId, 1_000_000n);
  assert.ok(projected.ok);
  assert.ok((projected.projection.resultingBufferPct ?? 0) < 0, 'still past liquidation');

  const action = customAction(projected.projection, BTC, 4242, 1);
  assert.match(action.label, /^Add 1 → still past liquidation, liquidation /);
  assert.doesNotMatch(action.label, /buffer -/);
});

test('margin past anything the market could take says there is no price left to reach', () => {
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const projected = harness.loop.projectAddMargin(BTC.marketId, 5_000_000_000_000n);
  assert.ok(projected.ok);
  const action = customAction(projected.projection, BTC, 4242, 1);
  // Not "liquidation -9,918,229.9": a price cannot go negative, so that is
  // arithmetic leaking into a message.
  assert.match(action.label, /no liquidation price left to reach$/);
});
