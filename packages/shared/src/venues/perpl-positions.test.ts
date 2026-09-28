/**
 * Decoding positions, against the frames actually captured from testnet.
 *
 * The fixture is the real lifecycle — empty snapshot, open, snapshot with the
 * position, close, empty snapshot — so these tests fail if the wire changes
 * shape, rather than agreeing with a shape we invented.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, test } from 'node:test';
import {
  POSITION_STATUS,
  describePositionStatus,
  exitPriceOf,
  isOpenPosition,
  parsePositionEntry,
  parsePositionFrame,
  positionIdOf,
  rawSizeOf,
  sideFromWire,
  type PositionEntry,
} from './perpl-positions.ts';
import { fromVenuePosition, type MarketRiskConfig } from '../risk/position.ts';
import type { VenueMarket } from './types.ts';

interface Fixture {
  readonly _market: {
    marketId: number;
    symbol: string;
    priceDecimals: number;
    sizeDecimals: number;
  };
  readonly _ledger: Record<string, string>;
  readonly lifecycle: ReadonlyArray<{
    stage: string;
    note: string;
    frame: { mt: number; d?: unknown[] };
  }>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../fixtures/positions-testnet.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

const stage = (name: string): { mt: number; d?: unknown[] } => {
  const found = fixture.lifecycle.find((s) => s.stage === name);
  if (!found) throw new Error(`fixture has no stage ${name}`);
  return found.frame;
};

const rowsOf = (name: string): PositionEntry[] => (stage(name).d ?? []) as PositionEntry[];

/** Testnet BTC, market 16, exactly as the context reports it. */
const btc: VenueMarket = {
  venue: 'perpl',
  network: 'testnet',
  marketId: 16,
  instanceId: 12,
  symbol: 'BTC',
  displayName: 'BTC Perp',
  priceDecimals: 1,
  sizeDecimals: 5,
  maxLeverage: 15,
  maintenanceMarginRatio: 0.04,
  makerFeeMicros: 45,
  takerFeeMicros: 345,
  fundingIntervalSec: 3600,
  orderTtlBlocks: 20,
  isOpen: true,
};

const ctx = { market: btc, network: 'testnet', collateralDecimals: 6 } as const;

describe('sideFromWire', () => {
  it('reads 1 as long and 2 as short', () => {
    assert.equal(sideFromWire(1), 'long');
    assert.equal(sideFromWire(2), 'short');
  });

  it('throws on Unspecified rather than guessing long', () => {
    // 0 is Unspecified on the wire. The contract's 0 is LONG, which is exactly
    // the confusion that makes defaulting dangerous.
    assert.throws(() => sideFromWire(0), /unrecognised position side/);
  });

  it('throws on anything else, including the string form', () => {
    assert.throws(() => sideFromWire(3), /unrecognised position side/);
    assert.throws(() => sideFromWire('long'), /unrecognised position side/);
    assert.throws(() => sideFromWire(null), /unrecognised position side/);
  });
});

describe('the captured open position', () => {
  const [row] = rowsOf('open');

  it('decodes every field to the value the ledger reconciled against', () => {
    assert.ok(row);
    const position = parsePositionEntry(row, ctx);
    assert.ok(position);
    assert.equal(position.venue, 'perpl');
    assert.equal(position.network, 'testnet');
    assert.equal(position.symbol, 'BTC');
    assert.equal(position.marketId, 16);
    assert.equal(position.side, 'long');
    // s: 1 at sizeDecimals 5.
    assert.equal(position.size, 0.00001);
    // ep: 833798 at priceDecimals 1.
    assert.equal(position.entryPrice, 83379.8);
    // c: "417125" — a decimal string, at 6 AUSD decimals.
    assert.equal(position.margin, 0.417125);
    assert.equal(position.marginMode, 'isolated');
    // lv: 200 hundredths.
    assert.equal(position.leverage, 2);
    assert.equal(position.fundingAccrued, 0);
    assert.equal(position.positionId, 4354895577089);
    assert.equal(position.status, POSITION_STATUS.Open);
    // fee: "288" — 3.45bps of the 0.833798 notional, the taker fee exactly.
    assert.equal(position.feePaid, 0.000288);
  });

  it('carries no mark price, because the wire does not send one', () => {
    assert.ok(row);
    const position = parsePositionEntry(row, ctx);
    assert.equal(position?.markPrice, undefined);
  });

  it('reports the reason on an update', () => {
    assert.ok(row);
    // sr 21 = PositionOpened.
    assert.equal(parsePositionEntry(row, ctx)?.statusReason, 21);
  });
});

describe('a snapshot is not an update', () => {
  it('carries no reason, even for the same position', () => {
    const [snapshotRow] = rowsOf('snapshot-open');
    const [updateRow] = rowsOf('open');
    assert.ok(snapshotRow);
    assert.ok(updateRow);

    const fromSnapshot = parsePositionEntry(snapshotRow, ctx);
    const fromUpdate = parsePositionEntry(updateRow, ctx);

    // Same position...
    assert.equal(fromSnapshot?.positionId, fromUpdate?.positionId);
    assert.equal(fromSnapshot?.size, fromUpdate?.size);
    assert.equal(fromSnapshot?.margin, fromUpdate?.margin);

    // ...but the snapshot says Unspecified where the update says
    // PositionOpened. Reading a reason off a snapshot gets 0, not the truth.
    assert.equal(fromSnapshot?.statusReason, 0);
    assert.equal(fromUpdate?.statusReason, 21);
  });
});

describe('a closed position is delivered, not omitted', () => {
  const [row] = rowsOf('close');

  it('arrives as a row with st 2 and zeroed size', () => {
    assert.ok(row);
    assert.equal(row['st'], POSITION_STATUS.Closed);
    assert.equal(row['s'], 0);
    assert.equal(row['c'], '0');
    assert.equal(isOpenPosition(row['st']), false);
  });

  it('decodes to undefined, which means REMOVE not IGNORE', () => {
    assert.ok(row);
    assert.equal(parsePositionEntry(row, ctx), undefined);
  });

  it('carries an exit price the open row does not', () => {
    const [openRow] = rowsOf('open');
    assert.ok(row);
    assert.ok(openRow);
    assert.equal(exitPriceOf(row, btc), 83443.6);
    assert.equal(exitPriceOf(openRow, btc), undefined);
  });
});

describe('every non-open status is treated as gone', () => {
  // Only the user-initiated close has been observed. The forced exits are
  // documented but unverified, so the rule deliberately does not depend on
  // anything about them except `st`.
  for (const [name, st] of [
    ['Closed', POSITION_STATUS.Closed],
    ['Liquidated', POSITION_STATUS.Liquidated],
    ['Deleveraged', POSITION_STATUS.Deleveraged],
    ['Unwound', POSITION_STATUS.Unwound],
    ['Failed', POSITION_STATUS.Failed],
    ['Unspecified', POSITION_STATUS.Unspecified],
  ] as const) {
    it(`drops a ${name} position without reading any other field`, () => {
      // Deliberately missing every field but `st`: if the parser touched
      // anything else it would throw rather than returning undefined.
      assert.equal(parsePositionEntry({ st }, ctx), undefined);
    });
  }
});

describe('parsePositionFrame', () => {
  it('separates open positions from closures', () => {
    const markets = new Map([[16, btc]]);
    const opened = parsePositionFrame(rowsOf('open'), markets, 'testnet', 6);
    assert.equal(opened.open.length, 1);
    assert.equal(opened.closedMarketIds.length, 0);

    const closed = parsePositionFrame(rowsOf('close'), markets, 'testnet', 6);
    assert.equal(closed.open.length, 0);
    assert.deepEqual(closed.closedMarketIds, [16]);
  });

  it('handles the empty snapshot', () => {
    const markets = new Map([[16, btc]]);
    const result = parsePositionFrame(rowsOf('snapshot-empty'), markets, 'testnet', 6);
    assert.equal(result.open.length, 0);
    assert.equal(result.closedMarketIds.length, 0);
  });

  it('skips a market it has no config for instead of losing the frame', () => {
    // A market listed on chain but absent from the context is real — mainnet
    // TAO is exactly this. One unknown market must not blind us to the rest.
    const markets = new Map([[16, btc]]);
    const rows = [...rowsOf('open'), { ...rowsOf('open')[0], mkt: 999 }];
    const result = parsePositionFrame(rows, markets, 'testnet', 6);
    assert.equal(result.open.length, 1);
    assert.deepEqual(result.skipped, [999]);
  });
});

describe('strictness', () => {
  const openRow = (): PositionEntry => ({ ...rowsOf('open')[0] } as PositionEntry);

  it('throws when a required numeric field is missing', () => {
    const row = openRow();
    delete row['ep'];
    assert.throws(() => parsePositionEntry(row, ctx), /`ep` must be a number/);
  });

  it('throws when an Amount is not a string or number', () => {
    const row = openRow();
    row['c'] = { value: 1 };
    assert.throws(() => parsePositionEntry(row, ctx), /`c` must be an Amount/);
  });

  it('throws when the position has no usable pid', () => {
    const row = openRow();
    row['pid'] = 0;
    assert.throws(() => parsePositionEntry(row, ctx), /no usable `pid`/);
  });

  it('refuses to decode a position against the wrong market', () => {
    const row = openRow();
    row['mkt'] = 32;
    assert.throws(() => parsePositionEntry(row, ctx), /is for market 32 but was decoded against/);
  });
});

test('positionIdOf and rawSizeOf read what a close order needs', () => {
  const [row] = rowsOf('open');
  assert.ok(row);
  // A close is addressed to `lp: pid` and sized in raw units — going through
  // the human float and back would be a needless round trip on a kill switch.
  assert.equal(positionIdOf(row), 4354895577089);
  assert.equal(rawSizeOf(row), 1);
});

test('describePositionStatus names what it knows', () => {
  assert.equal(describePositionStatus(1, 21), 'Open (PositionOpened)');
  assert.equal(describePositionStatus(2, 13), 'Closed (PositionClosed)');
  // A snapshot's 0 reason is not worth printing.
  assert.equal(describePositionStatus(1, 0), 'Open');
  assert.equal(describePositionStatus(3, 19), 'Liquidated (PositionLiquidated)');
});

test('the decoded position feeds the risk engine unchanged', () => {
  const [row] = rowsOf('open');
  assert.ok(row);
  const position = parsePositionEntry(row, ctx);
  assert.ok(position);

  const config: MarketRiskConfig = {
    marketId: 16,
    symbol: 'BTC',
    priceDecimals: 1,
    lotDecimals: 5,
    collateralDecimals: 6,
    maintenanceMargin: 2500,
    initialMargin: 1500,
  };

  // The whole point of the venue-agnostic shape: the engine's adapter takes it
  // as-is, and the raw integers come back out exactly as the wire sent them.
  const risk = fromVenuePosition(position, config);
  assert.equal(risk.lotLNS, 1n); // s: 1
  assert.equal(risk.entryPricePNS, 833798n); // ep: 833798
  assert.equal(risk.depositCNS, 417125n); // c: "417125"
  assert.equal(risk.fundingCNS, 0n);
  assert.equal(risk.side, 'long');
});
