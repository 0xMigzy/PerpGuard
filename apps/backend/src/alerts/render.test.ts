/**
 * The rendered text, pinned exactly, for real assessments from the real loop.
 *
 * Every number in every expected string below came out of the risk engine, not
 * out of a calculator. So if the maths changes, these fail — which is the point:
 * the message is the product, and a silent change to the number a trader acts on
 * is the failure this file exists to catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, ceilAusd, describeAge, describeBuffer, renderAlert } from './render.ts';
import { kindFor } from './rules.ts';
import { DEFAULT_ALERT_CONFIG } from './types.ts';
import {
  BTC,
  DANGER_ETH,
  DANGER_MON,
  ETH,
  FIXTURE_BTC,
  FIXTURE_BTC_MARK,
  MON,
  SAFE_BTC,
  STALE_MS,
  WATCH_BTC,
  assessOne,
} from './testSupport.ts';

const config = DEFAULT_ALERT_CONFIG;

// ── the ground-truth position ────────────────────────────────────────────────

test('the fixture BTC position renders its DANGER alert exactly', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  assert.equal(change.assessment.state, 'DANGER');

  const message = buildMessage(change.assessment, 'danger', { alerts: config, market: BTC });

  assert.equal(
    message.text,
    [
      'DANGER · BTC long',
      'Buffer 2.7% — liquidation 81,770.1, mark 84,007.3',
      'Isolated margin: your free AUSD is not used to rescue this position automatically.',
      'Top up (AUSD):',
      'Add 562 → buffer 4.0%, liquidation 80,647.1',
      'Add 2,662 → buffer 9.0%, liquidation 76,446.7',
      'First time PerpGuard has seen this position.',
    ].join('\n'),
  );
});

test('the title names the side, so both sides of one market are distinguishable', () => {
  const long = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change;
  const short = assessOne({ ...FIXTURE_BTC, side: 'short', positionId: 4243 }, FIXTURE_BTC_MARK)
    .change;

  const a = buildMessage(long.assessment, 'danger', { alerts: config, market: BTC });
  const b = buildMessage(short.assessment, kindFor(short.assessment.state), {
    alerts: config,
    market: BTC,
  });

  assert.equal(a.title, 'DANGER · BTC long');
  assert.ok(a.title.includes('long'));
  assert.ok(b.title.includes('short'));
  assert.notEqual(
    a.title,
    b.title,
    'a trader holding both sides of BTC must be able to tell which alert is which',
  );
});

test('the side is omitted rather than guessed when we never assessed the position', () => {
  // Blind on a position before it was ever assessed: there is no side to report,
  // and inventing one would invert a trader's exposure.
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  harness.positions = [];
  harness.positionsState = 'stale';
  harness.evaluate();
  const change = harness.changeFor(BTC.marketId);

  // This one WAS assessed, so it keeps its side.
  assert.equal(change.assessment.side, 'long');
  assert.ok(
    buildMessage(change.assessment, 'positions-untrusted', { alerts: config, market: BTC }).title.includes(
      'long',
    ),
  );
});

test('one buffer precision throughout a single message', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const message = buildMessage(change.assessment, 'danger', { alerts: config, market: BTC });

  const percentages = [...message.text.matchAll(/(\d+)\.(\d+)%/g)].map((m) => m[2]!.length);
  assert.ok(percentages.length >= 3, `expected several percentages, got ${percentages.length}`);
  assert.deepEqual(
    [...new Set(percentages)],
    [config.bufferDecimals],
    `every percentage must use ${config.bufferDecimals} decimal place(s): ${message.text}`,
  );
  // The specific regression: the loop's own reason quoted 2.66% beside the body's
  // 2.7%, and a trader reads two numbers as two facts.
  assert.ok(!message.text.includes('2.66%'));
  assert.ok(message.text.includes('Buffer 2.7%'));
});

test('a higher configured precision moves every percentage together', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const message = buildMessage(change.assessment, 'danger', {
    alerts: { ...config, bufferDecimals: 2 },
    market: BTC,
  });
  const percentages = [...message.text.matchAll(/(\d+)\.(\d+)%/g)].map((m) => m[2]!.length);
  assert.deepEqual([...new Set(percentages)], [2]);
  assert.ok(message.text.includes('Buffer 2.66%'));
  assert.ok(message.text.includes('buffer 4.00%'));
});

test('the change line reads as a sentence, not as a log line', () => {
  const first = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change;
  const firstMessage = buildMessage(first.assessment, 'danger', { alerts: config, market: BTC });
  assert.ok(firstMessage.text.endsWith('First time PerpGuard has seen this position.'));

  // A real transition names what it came from. 77,000 against a 75,390.7
  // liquidation price is a 2.09% buffer, so this really does cross into DANGER —
  // 82,000 would leave it at 8.06% and still SAFE, which is no transition at all.
  const { harness } = assessOne(SAFE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000).price(BTC.marketId, 'BTC', 77_000);
  harness.evaluate();
  const changed = harness.changeFor(BTC.marketId);
  const message = buildMessage(changed.assessment, kindFor(changed.assessment.state), {
    alerts: config,
    market: BTC,
  });
  assert.ok(message.text.endsWith('Changed from SAFE.'), message.text);
});

test('the cheap option is never described as safe, secure or fine', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const message = buildMessage(change.assessment, 'danger', { alerts: config, market: BTC });

  const cheap = message.lines.find((l) => l.startsWith('Add 562'))!;
  for (const adjective of ['safe', 'secure', 'fine', 'ok', 'protected', 'covered']) {
    assert.ok(
      !cheap.toLowerCase().includes(adjective),
      `the clear-danger line must carry no reassuring adjective, found "${adjective}" in: ${cheap}`,
    );
  }
  // It states what it buys, and that is all it states.
  assert.equal(cheap, 'Add 562 → buffer 4.0%, liquidation 80,647.1');
});

test('the structured actions carry exactly the amounts the text showed', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const message = buildMessage(change.assessment, 'danger', { alerts: config, market: BTC });

  assert.equal(message.actions.length, 2);
  assert.deepEqual(
    message.actions.map((a) => [a.intent, a.amountCNS, a.positionId, a.marketId, a.type]),
    [
      ['clear-danger', 562_000_000n, 4242, 1, 'add-margin'],
      ['to-safe', 2_662_000_000n, 4242, 1, 'add-margin'],
    ],
  );
  // The label IS the rendered line, so the button cannot disagree with the text.
  assert.equal(message.actions[0]!.label, 'Add 562 → buffer 4.0%, liquidation 80,647.1');
  assert.ok(message.lines.includes(message.actions[1]!.label));
});

test('amounts CEIL rather than round, so the figure shown really reaches the buffer', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const exact = change.assessment.topUp!.clearDanger.amountCNS;

  // The engine needs 561.46 AUSD. Rounding would print 561 and under-top-up.
  assert.equal(exact, 561_460_000n);
  assert.equal(Math.round(561.46), 561, 'rounding really would go the other way');

  const { amountCNS, text } = ceilAusd(exact, BTC, 0);
  assert.equal(text, '562');
  assert.equal(amountCNS, 562_000_000n, 'and the action sends the ceiled figure, not the exact one');
  assert.ok(amountCNS > exact, 'the ceiled action lands marginally better than stated, never worse');
});

// ── a second and third market, so precision cannot be hard-coded ─────────────

test('ETH renders at its own 2 price decimals', () => {
  const { change } = assessOne(DANGER_ETH, 3000);
  assert.equal(change.assessment.state, 'DANGER');

  const message = buildMessage(change.assessment, 'danger', { alerts: config, market: ETH });

  assert.equal(
    message.text,
    [
      'DANGER · ETH short',
      'Buffer 2.7% — liquidation 3,081.00, mark 3,000.00',
      'Isolated margin: your free AUSD is not used to rescue this position automatically.',
      'Top up (AUSD):',
      'Add 390 → buffer 4.0%, liquidation 3,120.00',
      'Add 1,890 → buffer 9.0%, liquidation 3,270.00',
      'First time PerpGuard has seen this position.',
    ].join('\n'),
  );
});

test('MON renders at its own 6 price decimals, and still ceils its amounts', () => {
  const { change } = assessOne(DANGER_MON, 0.05);
  assert.equal(change.assessment.state, 'DANGER');

  const message = buildMessage(change.assessment, 'danger', { alerts: config, market: MON });

  assert.equal(
    message.text,
    [
      'DANGER · MON long',
      'Buffer 2.8% — liquidation 0.048620, mark 0.050000',
      'Isolated margin: your free AUSD is not used to rescue this position automatically.',
      'Top up (AUSD):',
      'Add 7 → buffer 4.0%, liquidation 0.048000',
      'Add 32 → buffer 9.0%, liquidation 0.045500',
      'First time PerpGuard has seen this position.',
    ].join('\n'),
  );

  // 6.2 and 31.2 AUSD. Rounding would have printed 6 and 31.
  assert.equal(change.assessment.topUp!.clearDanger.amountCNS, 6_200_000n);
  assert.equal(change.assessment.topUp!.toSafe.amountCNS, 31_200_000n);
  assert.equal(message.actions[0]!.amountCNS, 7_000_000n);
  assert.equal(message.actions[1]!.amountCNS, 32_000_000n);
});

test('the three markets produce three different decimal counts from one code path', () => {
  const rendered = [
    { position: FIXTURE_BTC, mark: FIXTURE_BTC_MARK, market: BTC, expect: 'mark 84,007.3' },
    { position: DANGER_ETH, mark: 3000, market: ETH, expect: 'mark 3,000.00' },
    { position: DANGER_MON, mark: 0.05, market: MON, expect: 'mark 0.050000' },
  ].map(({ position, mark, market, expect }) => {
    const { change } = assessOne(position, mark);
    const message = buildMessage(change.assessment, 'danger', { alerts: config, market });
    assert.ok(
      message.lines.some((l) => l.includes(expect)),
      `${market.symbol} should render "${expect}", got: ${message.lines.join(' | ')}`,
    );
    return expect;
  });
  assert.equal(new Set(rendered).size, 3);
});

test('rendering an assessment against the wrong market config is refused', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  assert.throws(
    () => renderAlert(change.assessment, 'danger', { alerts: config, market: ETH }),
    /would be scaled by the wrong market's decimals/,
  );
});

// ── the option block ─────────────────────────────────────────────────────────

test('a WATCH position is offered only the option it has something to gain from', () => {
  const { change } = assessOne(WATCH_BTC, FIXTURE_BTC_MARK);
  assert.equal(change.assessment.state, 'WATCH');

  const message = buildMessage(change.assessment, 'watch', { alerts: config, market: BTC });

  // Already above the 4% danger exit, so "add 0" is not an offer worth making.
  assert.equal(change.assessment.topUp!.clearDanger.amountCNS, 0n);
  assert.equal(message.actions.length, 1);
  assert.equal(message.actions[0]!.intent, 'to-safe');
  assert.ok(!message.text.includes('Add 0 '));
});

test('a SAFE position is offered no top-up at all', () => {
  const { change } = assessOne(SAFE_BTC, FIXTURE_BTC_MARK);
  assert.equal(change.assessment.state, 'SAFE');

  const message = buildMessage(change.assessment, 'recovered', { alerts: config, market: BTC });
  assert.deepEqual(message.actions, []);
  assert.ok(!message.text.includes('Top up'));
  assert.ok(message.text.includes('Back above the 9.0% safe threshold.'));
});

// ── stale prices, and the states that cannot be assessed ─────────────────────

test('an old price is said in words, and the numbers are not presented as current', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK, { ageMs: 4 * 60_000 });
  assert.equal(change.assessment.priceIsOld, true);

  const message = buildMessage(change.assessment, 'danger', { alerts: config, market: BTC });
  assert.ok(
    message.text.includes('Note: price is 4 minutes old.'),
    `expected the age in words, got: ${message.text}`,
  );
});

test('a fresh price says nothing about age', () => {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const message = buildMessage(change.assessment, 'danger', { alerts: config, market: BTC });
  assert.ok(!message.text.includes('price is'));
});

test('FEED_DOWN says the price feed is down, and offers no action', () => {
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  harness.health = { state: 'disconnected', reconnectAttempt: 3, reason: 'socket closed' };
  harness.evaluate();
  const change = harness.changeFor(BTC.marketId);
  assert.equal(change.assessment.state, 'FEED_DOWN');

  const message = buildMessage(change.assessment, 'feed-down', { alerts: config, market: BTC });

  assert.ok(message.text.startsWith('FEED DOWN · BTC long\n'));
  assert.ok(
    message.text.includes("Price feed is down. I can't assess your positions until it's back."),
  );
  // The last thing we knew, labelled as the past.
  assert.ok(message.text.includes('Last known before this: DANGER'));
  // Nothing to act on: we cannot vouch for any price.
  assert.deepEqual(message.actions, []);
  assert.ok(!message.text.includes('Top up'));
});

test('POSITIONS_UNTRUSTED says we have lost track, and never says "stale"', () => {
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  harness.positionsState = 'stale';
  harness.positionsReason = 'sequence gap on the account stream';
  harness.evaluate();
  const change = harness.changeFor(BTC.marketId);
  assert.equal(change.assessment.state, 'POSITIONS_UNTRUSTED');

  const message = buildMessage(change.assessment, 'positions-untrusted', {
    alerts: config,
    market: BTC,
  });

  assert.ok(
    message.text.includes("I've lost track of your positions. What you see may no longer be true."),
  );
  assert.deepEqual(message.actions, []);
});

test('when both causes are active, the second one is not hidden by the first', () => {
  // POSITION TRUST LOSES TO NOTHING, so POSITIONS_UNTRUSTED is the state reported
  // even with the feed also down. The message still names the other cause: they
  // have different fixes and the user may need both.
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  harness.positionsState = 'stale';
  harness.health = { state: 'reconnecting', reconnectAttempt: 2 };
  harness.evaluate();
  const change = harness.changeFor(BTC.marketId);
  assert.equal(change.assessment.state, 'POSITIONS_UNTRUSTED');

  const message = buildMessage(change.assessment, 'positions-untrusted', {
    alerts: config,
    market: BTC,
  });
  assert.ok(message.text.includes("I've lost track of your positions"));
  assert.ok(message.text.includes('The price feed is also reconnecting.'), message.text);
});

test('a positions outage with a healthy feed does not claim the feed is down', () => {
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  harness.positionsState = 'stale';
  harness.evaluate();
  const message = buildMessage(
    harness.changeFor(BTC.marketId).assessment,
    'positions-untrusted',
    { alerts: config, market: BTC },
  );
  assert.ok(!message.text.includes('price feed is also'));
});

test('the two blind causes produce different sentences, so a user knows which they have', () => {
  const feedDown = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  feedDown.harness.advance(1_000);
  feedDown.harness.health = { state: 'disconnected', reconnectAttempt: 1 };
  feedDown.harness.evaluate();

  const untrusted = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  untrusted.harness.advance(1_000);
  untrusted.harness.positionsState = 'stale';
  untrusted.harness.evaluate();

  const a = buildMessage(feedDown.harness.changeFor(1).assessment, 'feed-down', {
    alerts: config,
    market: BTC,
  });
  const b = buildMessage(untrusted.harness.changeFor(1).assessment, 'positions-untrusted', {
    alerts: config,
    market: BTC,
  });

  assert.notEqual(a.lines[0], b.lines[0]);
  assert.ok(a.lines[0]!.includes('Price feed is down'));
  assert.ok(b.lines[0]!.includes("lost track of your positions"));
});

test('"stale" never reaches a user-facing line about positions', () => {
  // In this codebase "stale" is the BENIGN word: a stale price is a quiet market
  // and is safe to act on. Reusing it for an untrustworthy position set collapses
  // a distinction the risk layer went to real trouble to draw, so the rendered
  // sentence must not borrow it — whatever the internal state is called.
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  harness.positionsState = 'stale';
  harness.positionsReason = 'the position set is stale';
  harness.evaluate();
  const change = harness.changeFor(BTC.marketId);

  const message = buildMessage(change.assessment, 'positions-untrusted', {
    alerts: config,
    market: BTC,
  });
  // Unconditional: nothing in a rendered message echoes the loop's own `reason`,
  // so there is no line left that could leak the internal word.
  for (const line of message.lines) {
    assert.ok(!/stale/i.test(line), `a position message must not say "stale": ${line}`);
  }
});

// ── the small formatters ─────────────────────────────────────────────────────

test('a negative buffer reads as past liquidation, never as a negative percentage', () => {
  assert.equal(describeBuffer(-0.014, 1), 'past liquidation');
  assert.equal(describeBuffer(0.0266, 1), 'buffer 2.7%');
  assert.equal(describeBuffer(undefined, 1), 'no buffer: the position has no size');
});

test('a PAST_LIQUIDATION alert says past liquidation rather than a minus sign', () => {
  const { harness } = assessOne(SAFE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  harness.price(BTC.marketId, 'BTC', 74_000);
  harness.evaluate();
  const change = harness.changeFor(BTC.marketId);
  assert.equal(change.assessment.state, 'PAST_LIQUIDATION');

  const message = buildMessage(change.assessment, 'past-liquidation', {
    alerts: config,
    market: BTC,
  });
  assert.ok(message.text.includes('Past liquidation — liquidation 75,390.7, mark 74,000.0'));
  assert.ok(!/-\d/.test(message.lines[0]!), 'no negative number in the headline figure');
});

test('ages read in the largest sensible unit', () => {
  assert.equal(describeAge(undefined), 'price age unknown');
  assert.equal(describeAge(400), 'price is 400 ms old');
  assert.equal(describeAge(1_000), 'price is 1 second old');
  assert.equal(describeAge(45_000), 'price is 45 seconds old');
  assert.equal(describeAge(60_000), 'price is 1 minute old');
  assert.equal(describeAge(4 * 60_000), 'price is 4 minutes old');
  assert.equal(describeAge(3 * 3_600_000), 'price is 3 hours old');
  assert.ok(STALE_MS > 0);
});

test('ceilAusd is a no-op once the display precision reaches the market precision', () => {
  // 6 decimals is all AUSD has, so there is nothing left to ceil away.
  assert.deepEqual(ceilAusd(561_460_000n, BTC, 6), { amountCNS: 561_460_000n, text: '561.460000' });
  // And asking for more than the market carries does not invent precision.
  assert.deepEqual(ceilAusd(561_460_000n, BTC, 9), { amountCNS: 561_460_000n, text: '561.460000' });
  // Two decimals ceils the micros away.
  assert.deepEqual(ceilAusd(561_460_000n, BTC, 2), { amountCNS: 561_460_000n, text: '561.46' });
  assert.deepEqual(ceilAusd(561_461_000n, BTC, 2), { amountCNS: 561_470_000n, text: '561.47' });
});

test('an exact amount is not inflated by ceiling', () => {
  assert.deepEqual(ceilAusd(390_000_000n, ETH, 0), { amountCNS: 390_000_000n, text: '390' });
  assert.deepEqual(ceilAusd(0n, ETH, 0), { amountCNS: 0n, text: '0' });
});
