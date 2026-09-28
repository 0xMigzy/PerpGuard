/**
 * Decoding Perpl `Position` objects off the wire — pure, no I/O.
 *
 * THE SHAPE IS NOT DOCUMENTED. `types-and-errors.md` says the full object
 * shapes are documented "alongside the endpoints that return them";
 * `rest.md` and `websocket.md` both say see Types. The reference is circular,
 * the Rust SDK is unpublished, and the TypeScript docs type position history
 * as `any[]`. So every field below was read off a real position opened and
 * closed on testnet, captured in `fixtures/positions-testnet.json` and
 * reconciled to the micro in `docs/evidence.md`.
 *
 * Because the shape is measured rather than promised, this module is strict.
 * A field that is missing or of the wrong type throws, naming the field. It
 * never falls back to a default: a position decoded from a shape we no longer
 * recognise is exactly the input that makes a risk monitor confidently wrong.
 */
import { ausdFromRaw, priceFromRaw, sizeFromRaw, type RawAmount } from '../units.ts';
import type { NetworkName } from '../config.ts';
import type { Side, VenueMarket, VenuePosition } from './types.ts';

/**
 * `sd` on a Position — the API wire's PositionType.
 *
 * THIS IS NOT THE CONTRACT'S `positionType`, WHICH IS 0 = LONG, 1 = SHORT.
 * The value `1` means Long here and SHORT there. See the note on
 * {@link sideFromWire}.
 */
export const WIRE_POSITION_TYPE = {
  Unspecified: 0,
  Long: 1,
  Short: 2,
} as const;

/** `st` on a Position — PositionStatus. */
export const POSITION_STATUS = {
  Unspecified: 0,
  Open: 1,
  Closed: 2,
  Liquidated: 3,
  Deleveraged: 4,
  Unwound: 5,
  Failed: 6,
} as const;

export const POSITION_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: 'Unspecified',
  1: 'Open',
  2: 'Closed',
  3: 'Liquidated',
  4: 'Deleveraged',
  5: 'Unwound',
  6: 'Failed',
};

/** `sr` on a Position — PositionStatusReason, the documented common values. */
export const POSITION_STATUS_REASON_NAMES: Readonly<Record<number, string>> = {
  0: 'Unspecified',
  13: 'PositionClosed',
  14: 'PositionDecreased',
  15: 'PositionDeleveraged',
  17: 'PositionIncreased',
  18: 'PositionInverted',
  19: 'PositionLiquidated',
  21: 'PositionOpened',
  22: 'PositionUnwound',
};

export function describePositionStatus(st: number | undefined, sr?: number | undefined): string {
  const status = st === undefined ? 'no status' : (POSITION_STATUS_NAMES[st] ?? `status ${st}`);
  if (sr === undefined || sr === 0) return status;
  return `${status} (${POSITION_STATUS_REASON_NAMES[sr] ?? `reason ${sr}`})`;
}

/**
 * Side from the API wire's `sd`.
 *
 * ┌──────────────────────────┬─────────┬─────────┐
 * │ source                   │ 1 means │ 0 means │
 * ├──────────────────────────┼─────────┼─────────┤
 * │ API wire `sd` (here)     │ LONG    │ —       │
 * │ contract `positionType`  │ SHORT   │ LONG    │
 * └──────────────────────────┴─────────┴─────────┘
 *
 * THE TWO ENCODINGS ARE DELIBERATELY SEPARATE AND MUST NEVER BE UNIFIED.
 * `sideOf()` in `apps/indexer/src/lib/scale.ts` decodes the contract's
 * `positionType`; this decodes the API's `sd`. They look like duplicates and
 * are not — pointing either at the other's data inverts every long and short.
 * `apps/indexer/src/tests/side-encodings.test.ts` asserts the asymmetry so a
 * later tidy-up cannot quietly merge them.
 *
 * An unrecognised value throws rather than defaulting. Reading an unknown side
 * as long would tell a short trader to add margin as the price runs away from
 * them, which is the single worst thing this product can do.
 */
export function sideFromWire(sd: unknown): Side {
  if (sd === WIRE_POSITION_TYPE.Long) return 'long';
  if (sd === WIRE_POSITION_TYPE.Short) return 'short';
  throw new RangeError(
    `unrecognised position side sd=${JSON.stringify(sd)}; expected ` +
      `${WIRE_POSITION_TYPE.Long} (Long) or ${WIRE_POSITION_TYPE.Short} (Short). ` +
      `Refusing to guess: the contract's positionType uses 0=LONG/1=SHORT, so a ` +
      `wrong guess here silently inverts the position.`,
  );
}

/**
 * Whether a position row represents a position that still exists.
 *
 * A CLOSED POSITION IS STILL DELIVERED. The close arrives as a row in `d` with
 * `st: 2`, `s: 0` and `c: "0"` — not as an omission — so anything that upserts
 * whatever arrives keeps a zero-size ghost forever. Measured on testnet.
 *
 * Everything outside Open is treated as gone, which is the right handling for
 * Closed, Liquidated, Deleveraged, Unwound and Failed alike. That matters
 * because only the user-initiated close has actually been observed: the
 * forced-exit shapes are documented but unverified, and this rule does not
 * depend on what their other fields turn out to contain.
 */
export function isOpenPosition(st: unknown): boolean {
  return st === POSITION_STATUS.Open;
}

/** One entry from the `d` array of an `mt: 26` or `mt: 27` frame. */
export type PositionEntry = Record<string, unknown>;

/**
 * A decoded Perpl position.
 *
 * Extends the venue-agnostic shape with the few wire facts a Perpl action
 * needs — chiefly `positionId`, which is the `lp` a close is addressed to and
 * cannot be reconstructed from anything else.
 */
export interface PerplPosition extends VenuePosition {
  /** `pid`. The `lp` field of a close order. Read it, never derive it. */
  readonly positionId: number;
  /** `st`. Always Open here: anything else is filtered out before this. */
  readonly status: number;
  /** `sr`. 0 (Unspecified) on a snapshot — a snapshot carries no reason. */
  readonly statusReason: number;
  /** `dpnl`, AUSD. Realized on this position so far. */
  readonly realizedPnl: number;
  /** `fee`, AUSD. */
  readonly feePaid: number;
}

export interface ParsePositionContext {
  readonly market: VenueMarket;
  readonly network: NetworkName;
  /** AUSD decimals, from the context `tokens[]` entry. Never assumed to be 6. */
  readonly collateralDecimals: number;
}

function requireNumber(entry: PositionEntry, key: string): number {
  const value = entry[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(
      `position field \`${key}\` must be a number, got ${JSON.stringify(value)}. ` +
        `The Position shape is undocumented and was measured, so a change here is ` +
        `a real change — see docs/evidence.md.`,
    );
  }
  return value;
}

/**
 * An AUSD `Amount`, which the wire sends as a DECIMAL STRING.
 *
 * The docs are explicit that these must not go through `Number()`, and
 * `scaledToNumber` does not: it parses the digits into a bigint and builds the
 * decimal value from them, so nothing is lost on the way in.
 */
function requireAmount(entry: PositionEntry, key: string, decimals: number): number {
  const value = entry[key];
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new RangeError(
      `position field \`${key}\` must be an Amount (decimal string), got ${JSON.stringify(value)}`,
    );
  }
  return ausdFromRaw(value as RawAmount, decimals);
}

/** `pid`, the position id a close is addressed to. */
export function positionIdOf(entry: PositionEntry): number | undefined {
  const pid = entry['pid'];
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Decode one position row, or `undefined` if it no longer represents an open
 * position.
 *
 * `undefined` is the signal to REMOVE it from a tracked set, not to ignore it:
 * a close arrives as a row, not as an absence.
 */
export function parsePositionEntry(
  entry: PositionEntry,
  ctx: ParsePositionContext,
): PerplPosition | undefined {
  const st = entry['st'];
  if (!isOpenPosition(st)) return undefined;

  const marketId = requireNumber(entry, 'mkt');
  if (marketId !== ctx.market.marketId) {
    throw new RangeError(
      `position is for market ${marketId} but was decoded against ` +
        `${ctx.market.symbol} (market ${ctx.market.marketId})`,
    );
  }

  const positionId = positionIdOf(entry);
  if (positionId === undefined) {
    throw new RangeError(
      `position has no usable \`pid\`, got ${JSON.stringify(entry['pid'])}. ` +
        `Without it a close cannot be addressed to this position.`,
    );
  }

  const leverageHundredths = requireNumber(entry, 'lv');

  return {
    venue: 'perpl',
    network: ctx.network,
    symbol: ctx.market.symbol,
    marketId,
    side: sideFromWire(entry['sd']),
    size: sizeFromRaw(requireNumber(entry, 's'), ctx.market),
    entryPrice: priceFromRaw(requireNumber(entry, 'ep'), ctx.market),
    // No markPrice: the wire does not carry one, and neither does a
    // liquidation price. Both are computed by the risk engine off the feed.
    margin: requireAmount(entry, 'c', ctx.collateralDecimals),
    marginMode: 'isolated',
    leverage: leverageHundredths / 100,
    // Sign UNVERIFIED. `fnd` was "0" on the only position we have observed, so
    // which way a negative reads is untested. RiskPosition subtracts it from
    // margin; if that turns out to be backwards it shows up as a liquidation
    // price that drifts the wrong way as funding accrues.
    fundingAccrued: requireAmount(entry, 'fnd', ctx.collateralDecimals),
    positionId,
    status: POSITION_STATUS.Open,
    statusReason: typeof entry['sr'] === 'number' ? entry['sr'] : 0,
    realizedPnl: requireAmount(entry, 'dpnl', ctx.collateralDecimals),
    feePaid: requireAmount(entry, 'fee', ctx.collateralDecimals),
  };
}

/**
 * The exit price on a closed position (`xp`), if it carries one.
 *
 * Present on the user-initiated close we observed. NOT assumed to be present
 * on a liquidation, deleverage or unwind — those shapes are documented but
 * have never been seen on the wire.
 */
export function exitPriceOf(entry: PositionEntry, market: VenueMarket): number | undefined {
  const xp = entry['xp'];
  return typeof xp === 'number' ? priceFromRaw(xp, market) : undefined;
}

/**
 * Decode a whole `d` array, keeping only positions that still exist.
 *
 * Rows for markets we have no config for are skipped rather than throwing: a
 * market listed on chain but absent from the context is a real situation (see
 * CLAUDE.md), and one unknown market must not blind us to every other
 * position in the frame.
 */
export function parsePositionFrame(
  rows: readonly unknown[],
  markets: ReadonlyMap<number, VenueMarket>,
  network: NetworkName,
  collateralDecimals: number,
): { readonly open: PerplPosition[]; readonly closedMarketIds: number[]; readonly skipped: number[] } {
  const open: PerplPosition[] = [];
  const closedMarketIds: number[] = [];
  const skipped: number[] = [];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const entry = row as PositionEntry;
    const marketId = entry['mkt'];
    if (typeof marketId !== 'number') continue;

    const market = markets.get(marketId);
    if (market === undefined) {
      skipped.push(marketId);
      continue;
    }
    const parsed = parsePositionEntry(entry, { market, network, collateralDecimals });
    if (parsed === undefined) closedMarketIds.push(marketId);
    else open.push(parsed);
  }

  return { open, closedMarketIds, skipped };
}

/** Raw scaled size, for building a close order without a float round trip. */
export function rawSizeOf(entry: PositionEntry): number | undefined {
  const s = entry['s'];
  return typeof s === 'number' && Number.isInteger(s) && s > 0 ? s : undefined;
}
