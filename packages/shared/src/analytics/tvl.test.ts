/**
 * The TVL chain read.
 *
 * The tests that matter are the ones where a wrong answer would be SILENT: an
 * `eth_call` that reached nothing returns `0x`, and a reading of zero would go
 * straight onto a dashboard as a headline figure. Every failure path here has to
 * come back `known: false`, never a number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TvlProbe, decodeBalance } from './tvl.ts';

/** Mainnet, from the indexer's own Exchange row. */
const EXCHANGE = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
const NOW = Date.parse('2026-09-30T05:04:14Z');

/** 1,234,567.891234 AUSD in micros, as a 32-byte word. */
const WORD = `0x${(1_234_567_891_234n).toString(16).padStart(64, '0')}`;

interface Capture {
  url: string;
  body: Record<string, unknown>;
}

function probe(
  respond: (capture: Capture) => unknown,
  options: { ttlMs?: number; nowMs?: () => number } = {},
): { readonly probe: TvlProbe; readonly calls: Capture[] } {
  const calls: Capture[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const capture: Capture = {
      url: String(url),
      body: JSON.parse(String((init as { body: string }).body)) as Record<string, unknown>,
    };
    calls.push(capture);
    const result = respond(capture);
    if (result instanceof Error) throw result;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => result,
    } as Response;
  }) as unknown as typeof fetch;

  return {
    calls,
    probe: new TvlProbe({
      rpcUrl: 'https://rpc.monad.xyz',
      tokenAddress: AUSD,
      exchangeAddress: EXCHANGE,
      collateralDecimals: 6,
      fetchImpl,
      now: options.nowMs ?? (() => NOW),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    }),
  };
}

// ── the happy path, and the calldata ────────────────────────────────────────

test('a balance word decodes to AUSD and keeps the exact micros', async () => {
  const { probe: p } = probe(() => ({ result: WORD }));
  const reading = await p.read();

  assert.ok(reading.known);
  assert.equal(reading.totalValueLockedCNS, 1_234_567_891_234n);
  assert.equal(reading.totalValueLockedAusd, 1_234_567.891234);
  assert.equal(reading.source, 'chain');
  assert.equal(reading.asOfMs, NOW);
});

test('the call is balanceOf(exchange) sent TO the token', async () => {
  // The two addresses are easy to swap, and swapping them returns 0x rather than
  // an error — which is why decodeBalance refuses an empty word.
  const { probe: p, calls } = probe(() => ({ result: WORD }));
  await p.read();

  const params = (calls[0]!.body['params'] as Array<Record<string, string>>)[0]!;
  assert.equal(calls[0]!.body['method'], 'eth_call');
  assert.equal(params['to'], AUSD, 'sent to the ERC-20');
  // Selector, then the PROXY padded to 32 bytes. Collateral sits in the proxy.
  assert.equal(
    params['data'],
    `0x70a08231${'34b6552d57a35a1d042ccae1951bd1c370112a6f'.padStart(64, '0')}`,
  );
});

test('the collateral decimals come from the caller, not from a constant', () => {
  const atSix = decodeBalance(WORD, 6, NOW);
  assert.ok(atSix.known);
  assert.equal(atSix.totalValueLockedAusd, 1_234_567.891234);

  const atTwo = decodeBalance(WORD, 2, NOW);
  assert.ok(atTwo.known);
  assert.equal(atTwo.totalValueLockedAusd, 12_345_678_912.34);
});

// ── every failure is unknown, never zero ────────────────────────────────────

test('an empty 0x is UNKNOWN, not a balance of zero', async () => {
  // What an eth_call to a non-contract or to the wrong address returns. A zero
  // here would render as a confident 0.00 AUSD headline.
  const { probe: p } = probe(() => ({ result: '0x' }));
  const reading = await p.read();

  assert.equal(reading.known, false);
  assert.ok(!reading.known);
  assert.match(reading.reason, /did not reach an ERC-20/);
  assert.match(reading.reason, /check the collateral token address, not the balance/);
});

test('an RPC error is unknown', async () => {
  const { probe: p } = probe(() => ({ error: { message: 'execution reverted' } }));
  const reading = await p.read();
  assert.ok(!reading.known);
  assert.match(reading.reason, /execution reverted/);
});

test('a thrown fetch — a timeout, a dropped socket — is unknown', async () => {
  const { probe: p } = probe(() => new Error('The operation was aborted due to timeout'));
  const reading = await p.read();
  assert.ok(!reading.known);
  assert.match(reading.reason, /aborted due to timeout/);
});

test('a non-hex result is unknown', async () => {
  for (const result of [null, 42, 'not hex', {}, undefined]) {
    const { probe: p } = probe(() => ({ result }));
    const reading = await p.read();
    assert.equal(reading.known, false, JSON.stringify(result));
  }
});

test('a genuine zero balance IS known and IS zero', async () => {
  // The distinction the empty-0x case exists to preserve: a real zero word is a
  // real answer.
  const { probe: p } = probe(() => ({ result: `0x${'0'.repeat(64)}` }));
  const reading = await p.read();
  assert.ok(reading.known);
  assert.equal(reading.totalValueLockedCNS, 0n);
  assert.equal(reading.totalValueLockedAusd, 0);
});

// ── caching ─────────────────────────────────────────────────────────────────

test('a reading is cached for its TTL and re-read after it', async () => {
  const clock = { nowMs: NOW };
  const { probe: p, calls } = probe(() => ({ result: WORD }), {
    ttlMs: 30_000,
    nowMs: () => clock.nowMs,
  });

  await p.read();
  await p.read();
  assert.equal(calls.length, 1, 'the second read is served from cache');

  clock.nowMs += 29_999;
  await p.read();
  assert.equal(calls.length, 1, 'still inside the TTL');

  clock.nowMs += 1;
  await p.read();
  assert.equal(calls.length, 2, 're-read at the TTL');
});

test('concurrent readers share ONE eth_call', async () => {
  // A dashboard rendering several tiles must not produce several calls.
  const { probe: p, calls } = probe(() => ({ result: WORD }));
  const readings = await Promise.all([p.read(), p.read(), p.read(), p.read()]);
  assert.equal(calls.length, 1);
  for (const reading of readings) assert.ok(reading.known);
});

test('a failure is cached briefly too, so a struggling RPC is not hammered', async () => {
  const clock = { nowMs: NOW };
  let attempts = 0;
  const { probe: p } = probe(
    () => {
      attempts += 1;
      return new Error('connection refused');
    },
    { ttlMs: 30_000, nowMs: () => clock.nowMs },
  );

  await p.read();
  await p.read();
  await p.read();
  assert.equal(attempts, 1, 'a dashboard refreshing every second does not retry every second');

  clock.nowMs += 30_000;
  await p.read();
  assert.equal(attempts, 2);
});

test('a stale reading is NEVER served past its TTL', async () => {
  // TVL is a LEVEL: a stale level is a wrong number, not an old one. So once the
  // TTL passes and the re-read fails, the answer becomes unknown rather than the
  // last good figure.
  const clock = { nowMs: NOW };
  let fail = false;
  const { probe: p } = probe(
    () => (fail ? new Error('rpc down') : { result: WORD }),
    { ttlMs: 1_000, nowMs: () => clock.nowMs },
  );

  assert.ok((await p.read()).known);
  fail = true;
  clock.nowMs += 1_001;
  const after = await p.read();
  assert.equal(after.known, false, 'not the last good value');
});

// ── construction ────────────────────────────────────────────────────────────

test('a malformed address is refused at construction, before any call', () => {
  for (const bad of ['0x123', 'not-an-address', '', EXCHANGE.slice(0, -1)]) {
    assert.throws(
      () =>
        new TvlProbe({
          rpcUrl: 'https://rpc.monad.xyz',
          tokenAddress: bad,
          exchangeAddress: EXCHANGE,
          collateralDecimals: 6,
        }),
      /must be a 0x-prefixed 20-byte address/,
      bad,
    );
  }
});
