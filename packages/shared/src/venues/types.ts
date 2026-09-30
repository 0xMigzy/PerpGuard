import type { NetworkConfig, NetworkName } from '../config.ts';
import type { MarketRiskConfig } from '../risk/position.ts';

/**
 * The venue abstraction. Everything downstream — risk engine, bot, web — talks
 * to this interface and never to a venue's API directly. Venue-specific code
 * lives only in this directory.
 */

export type VenueId = 'perpl';

export type Side = 'long' | 'short';

/** +1 for a long, -1 for a short. Used by the risk maths. */
export function sideSign(side: Side): 1 | -1 {
  return side === 'long' ? 1 : -1;
}

export interface VenueMarket {
  readonly venue: VenueId;
  readonly network: NetworkName;
  /**
   * The venue's own market id. Differs per network for the same asset — BTC is
   * 1 on mainnet and 16 on testnet — so it is never hard-coded anywhere.
   */
  readonly marketId: number;
  readonly instanceId: number;
  /**
   * Canonical asset ticker, e.g. 'BTC'. Stable across networks, and the key to
   * match a mainnet market to its testnet counterpart. Taken from
   * `size_units`, because `symbol` comes back empty and `name` differs by
   * network ('BTC' vs 'BTC Perp').
   */
  readonly symbol: string;
  /** The venue's display name, for UI only. Never match on this. */
  readonly displayName: string;
  /** Decimal places for prices on this market, per network. */
  readonly priceDecimals: number;
  /** Decimal places for sizes. 0 on some markets, i.e. integer sizes only. */
  readonly sizeDecimals: number;
  /** Derived from config.initial_margin. See maxLeverageFromConfig. */
  readonly maxLeverage: number;
  /** Derived from config.maintenance_margin. Fraction of notional. */
  readonly maintenanceMarginRatio: number;
  /** Fee in Micros (10^-6 fractions), as the venue reports it: 345 is 3.45 bps. */
  readonly makerFeeMicros: number;
  readonly takerFeeMicros: number;
  readonly fundingIntervalSec: number;
  /**
   * How many blocks past the head an order may remain executable. Bounds the
   * `lb` field on a submission; 20 on testnet BTC, i.e. seconds, not minutes.
   */
  readonly orderTtlBlocks: number;
  readonly isOpen: boolean;
}

export interface VenuePosition {
  readonly venue: VenueId;
  readonly network: NetworkName;
  readonly symbol: string;
  readonly marketId: number;
  /**
   * The venue's own handle for this position, when it publishes one.
   *
   * OPAQUE above the adapter: nothing outside `venues/` may parse it, compare it
   * across venues or derive anything from it. It is carried so an action can be
   * ADDRESSED to the right position — on Perpl it is `pid`, the `lp` a close
   * order names, and it cannot be reconstructed from any other field.
   *
   * Optional because it is a venue fact rather than a risk fact: the risk engine
   * keys on `marketId` and needs none of it. {@link PerplPosition} narrows it to
   * required, since a Perpl position always has one.
   */
  readonly positionId?: number;
  readonly side: Side;
  /** Absolute position size in base units. */
  readonly size: number;
  readonly entryPrice: number;
  /**
   * OPTIONAL, because a Perpl position does not carry one. The wire publishes
   * no mark price and no liquidation price on a Position — both are computed
   * by the risk engine from the live feed, which is the only source that can
   * say how old the number is. Present only when a caller has attached a mark
   * it got from somewhere it can vouch for.
   */
  readonly markPrice?: number;
  /**
   * Collateral posted to THIS position, in AUSD. Perpl is isolated margin:
   * free account balance is never pulled in to rescue it. Always the venue's
   * reported figure — never notional / leverage, which understates it.
   */
  readonly margin: number;
  readonly marginMode: 'isolated';
  readonly leverage: number;
  readonly fundingAccrued: number;
}

/** One price tick for a market. Prices are already descaled to human numbers. */
export interface PriceUpdate {
  readonly venue: VenueId;
  readonly network: NetworkName;
  readonly symbol: string;
  readonly marketId: number;
  readonly markPrice: number;
  readonly oraclePrice: number;
  readonly midPrice: number;
  readonly bid: number;
  readonly ask: number;
  readonly atBlock: number;
  /** Venue timestamp for the data itself. */
  readonly atMs: number;
  /** When we received it. Both feed the STALE_MS check. */
  readonly receivedAtMs: number;
}

export type Unsubscribe = () => void;

/**
 * Connection health of a price feed.
 *
 * This is NOT the same question as how old a given price is, and conflating
 * the two is a real hazard. On Perpl a mark price only changes when it moves,
 * so a market that has not traded for a minute has a one-minute-old price that
 * is nonetheless the venue's current truth. That is a QUIET MARKET, and it is
 * perfectly safe to act on.
 *
 * A feed that is not `connected` is the opposite: the prices we hold are
 * frozen at whatever they were when the connection died, and the real market
 * may have moved arbitrarily far since. Age cannot tell the two apart — a
 * frozen price looks exactly like a quiet one for the first few seconds — so
 * connection health has to be asked separately.
 */
export type FeedConnectionState =
  /** Live and subscribed. Prices are arriving, or the market is simply quiet. */
  | 'connected'
  /** The connection dropped and is being retried. Prices are frozen. */
  | 'reconnecting'
  /** No connection, and not about to have one soon. Prices are frozen. */
  | 'disconnected';

export interface FeedHealth {
  readonly state: FeedConnectionState;
  /** Human-readable, safe to render directly. Present when not connected. */
  readonly reason?: string;
  /** Consecutive failed reconnect attempts. 0 while healthy. */
  readonly reconnectAttempt: number;
  /** When the current healthy connection was established. Only when connected. */
  readonly connectedSinceMs?: number;
  /** When we last had a working connection. Absent if we never have. */
  readonly lastConnectedAtMs?: number;
  /** How long we have been without one. Absent while connected. */
  readonly downForMs?: number;
}

/** Whether prices from a feed in this state can be acted on at all. */
export function feedIsActionable(health: FeedHealth): boolean {
  return health.state === 'connected';
}

/**
 * Whether the set of open positions reflects reality right now.
 *
 * The SECOND health question, and deliberately separate from {@link FeedHealth}
 * — a message must be able to say "position data is stale" rather than "price
 * feed is down", because they have different causes and different fixes.
 *
 * A FROZEN POSITION SET IS WORSE THAN A FROZEN PRICE. A price at least carries
 * a timestamp, so age is some evidence. A position closed a minute ago looks
 * exactly like one still open: nothing about the set reveals the problem, and
 * there is no field to inspect. So the source has to volunteer the answer and
 * the consumer has to ask for it.
 */
export type PositionSourceState =
  /** Subscribed, snapshot received, no gaps. The set is the truth. */
  | 'live'
  /**
   * Connected but not yet told what is open. NOT the same as "nothing open",
   * and must never be rendered as an empty portfolio.
   */
  | 'awaiting-snapshot'
  /**
   * The set is frozen or possibly incomplete: the socket closed, or a sequence
   * gap means an update may have been missed. What we hold is the last known,
   * not the current.
   */
  | 'stale';

export interface PositionSourceStatus {
  readonly state: PositionSourceState;
  /** Human-readable, safe to render directly. Absent when live. */
  readonly reason?: string;
  /** When the set last changed, or was last confirmed by a snapshot. */
  readonly lastUpdateMs: number | undefined;
  /** How old that is. Undefined before anything has arrived. */
  readonly ageMs: number | undefined;
}

/**
 * Whether positions from a source in this state may be assessed.
 *
 * `live` only. Both other states mean we do not know what is open, and a risk
 * number computed over a set we cannot vouch for is worse than no number.
 */
export function positionsAreUsable(status: PositionSourceStatus): boolean {
  return status.state === 'live';
}

/** Why a market cannot be acted on, for the UI to show next to a disabled button. */
export type ActionUnavailableCode =
  /** The asset is monitored, but the acting network has no market for it. */
  | 'not-listed-on-acting-network'
  /** The market exists but the venue has it closed. */
  | 'market-closed'
  /** This venue is configured for analytics only and never acts. */
  | 'venue-read-only';

/**
 * Whether actions can be sent for a market on this venue's network.
 *
 * Monitoring and actionability are separate concerns: a position is watched and
 * alerted on regardless of the answer here. See the action availability rule in
 * CLAUDE.md.
 */
export type ActionAvailability =
  | {
      readonly actionable: true;
      readonly network: NetworkName;
      /** The market id on the acting network, which actions must target. */
      readonly marketId: number;
    }
  | {
      readonly actionable: false;
      readonly network: NetworkName;
      readonly code: ActionUnavailableCode;
      /** Human-readable, safe to render directly next to a disabled control. */
      readonly reason: string;
    };

/**
 * Outcome of a state-changing request.
 *
 * `forwarded` is NOT success. Perpl answers a submission with `mt: 3` /
 * `code: 0`, which means accepted for forwarding only — not posted, not
 * filled. The real outcome arrives later on `mt: 24`, and only that produces
 * `confirmed` or `rejected`. Never report success to a user on `forwarded`.
 */
export type ActionStatus = 'forwarded' | 'confirmed' | 'rejected';

export interface ActionResult {
  readonly status: ActionStatus;
  /** Caller-supplied idempotency key, also the action_log row key. */
  readonly idempotencyKey: string;
  readonly venue: VenueId;
  readonly network: NetworkName;
  readonly symbol: string;
  /** Venue order/request id once known. */
  readonly venueRef?: string;
  /** Present when status is 'rejected'. */
  readonly reason?: string;
  readonly at: number;
}

export interface ActionRequest {
  /** Required on every action: one in-flight action per position. */
  readonly idempotencyKey: string;
  readonly symbol: string;
  /**
   * Called when the venue admits the request for forwarding — Perpl's
   * `mt: 3` / `code: 0`. Provided so a caller can show "submitted" without any
   * promise ever resolving on it: the action promise resolves only on the real
   * outcome. Anything shown here must not read as success.
   */
  readonly onForwarded?: (ack: ActionResult) => void;
  /** Overrides the venue default for how long to wait for the outcome. */
  readonly timeoutMs?: number;
}

/**
 * A resting limit order.
 *
 * Not a product action in itself — PerpGuard never asks a user to place one —
 * but it is the primitive the day-1 connectivity check exercises and the one
 * reduce/close will submit, so it goes through the same executor and the same
 * result tracking as everything else.
 */
export interface PlaceLimitOrderRequest extends ActionRequest {
  readonly side: Side;
  /** Human units; scaled to the market's ticks by the venue. */
  readonly price: number;
  /** Human units, e.g. 0.00001 BTC. */
  readonly size: number;
  readonly leverage: number;
  /** Maker-only. The order is rejected rather than allowed to cross. */
  readonly postOnly?: boolean;
}

export interface CancelOrderRequest extends ActionRequest {
  /** The venue's order id, as returned in a previous ActionResult.venueRef. */
  readonly venueOrderId: string;
}

export interface AddMarginRequest extends ActionRequest {
  /**
   * `lp` — the position to top up. REQUIRED, and read off the live position.
   *
   * Isolated margin means collateral goes to ONE position, so there is no
   * account-level top-up to fall back on and nothing to default this to. It
   * cannot be reconstructed from the market id either: a market that goes flat
   * and is reopened is a new position with a new id.
   */
  readonly positionId: number;
  /**
   * Collateral to ADD, in AUSD micros. Not the new total.
   *
   * A BIGINT, not a human number: this is the figure a user read on a
   * confirmation screen and it has to reach the wire unchanged. Money maths in
   * this repo is integer-only, and `1000.07` through a float is how the amount
   * sent stops being the amount shown.
   */
  readonly amountCNS: bigint;
}

/**
 * What a close or a reduce needs, beyond the base request.
 *
 * Every field here is one that CANNOT BE GUESSED, and each was confirmed by the
 * measured round trips on 2026-09-30 (`fixtures/close-probe-testnet.json`):
 *
 *   `positionId` is `lp`. Read it off the live position. A market that goes flat
 *   and reopens gets a new one, and a reduce KEEPS the id it had — measured,
 *   `pid 4383112298497` was the same before and after a partial.
 *
 *   `positionSide` is the side of the POSITION, not of the order that closes it.
 *   Closing a long sends CloseLong, which is itself a sell. Passing the order's
 *   direction reverses the trade and doubles the position instead of flattening
 *   it, which is the worst single mistake available in this file.
 *
 *   `sizeLNS` is scaled by the market's own `size_decimals`, as an exact integer.
 *   Human floats do not appear in money or size maths here: `s: 1` is one size
 *   unit, which on testnet BTC is 0.00001.
 */
interface PositionExitRequest extends ActionRequest {
  readonly positionId: number;
  readonly positionSide: Side;
  readonly sizeLNS: bigint;
}

/** Close part of a position, leaving the rest open. */
export interface ReducePositionRequest extends PositionExitRequest {}

/**
 * Close a whole position.
 *
 * Structurally identical to a reduce, because on the wire it IS one: the same
 * `t: 3`/`t: 4` frame with `s` equal to the whole size. Two methods rather than
 * one because the CALLER's intent differs and the reconciliation differs — a
 * close is judged against "is it flat", a reduce against "did the right amount
 * come off".
 */
export interface ClosePositionRequest extends PositionExitRequest {}

/** Cancels every open order, optionally limited to one market. */
export interface CancelAllRequest {
  readonly idempotencyKey: string;
  readonly symbol?: string;
}

export interface Venue {
  readonly id: VenueId;
  readonly network: NetworkConfig;

  /** All markets, with their per-network ids and scaling. */
  getMarkets(): Promise<VenueMarket[]>;

  /**
   * Everything the risk engine needs per market, keyed by market id.
   *
   * Separate from {@link getMarkets} because the risk maths is integer-only and
   * needs the venue's RAW margin integers, not the human-friendly ratios
   * `VenueMarket` carries. Re-deriving those ints by inverting a float ratio is
   * how a maintenance margin ends up off by one in the last place, so the
   * adapter reads them straight from the venue's own config.
   *
   * Never hard-coded, and never shared between networks: scaling differs.
   */
  getRiskConfigs(): Promise<ReadonlyMap<number, MarketRiskConfig>>;

  /**
   * Whether actions for `symbol` can be sent on this venue's network.
   *
   * Callers ask this of the ACTING venue, which is not necessarily the venue a
   * position was read from: analytics runs on mainnet while actions run on
   * testnet, and the two do not list the same markets. A false answer disables
   * the action controls and nothing else — monitoring and alerts continue.
   *
   * @param symbol canonical ticker, e.g. 'HYPE'.
   */
  getActionAvailability(symbol: string): Promise<ActionAvailability>;

  getPositions(address: string): Promise<VenuePosition[]>;

  /**
   * Connection health of this venue's price feed.
   *
   * Synchronous by design: something deciding whether to act must not have to
   * await an answer about whether its own data can be trusted.
   *
   * Ask this, never price age, to decide whether acting is safe. Price age
   * answers a different question — "how old is this number" — and a quiet
   * market gives an old number on a perfectly healthy feed. See
   * FeedConnectionState.
   */
  feedStatus(): FeedHealth;

  /** @param symbols canonical tickers, e.g. ['BTC', 'ETH']. */
  subscribePrices(
    symbols: readonly string[],
    onUpdate: (update: PriceUpdate) => void,
  ): Promise<Unsubscribe>;

  /**
   * Place a resting limit order and resolve on the venue's real outcome.
   *
   * Never resolves on an admission acknowledgement: on Perpl that is `mt: 3`,
   * which means forwarded, not posted and not filled. Use `onForwarded` to
   * observe that stage. A timeout throws ActionTimeoutError rather than
   * resolving, because the outcome is then unknown rather than failed.
   */
  placeLimitOrder(request: PlaceLimitOrderRequest): Promise<ActionResult>;

  cancelOrder(request: CancelOrderRequest): Promise<ActionResult>;

  addMargin(request: AddMarginRequest): Promise<ActionResult>;
  reducePosition(request: ReducePositionRequest): Promise<ActionResult>;
  closePosition(request: ClosePositionRequest): Promise<ActionResult>;
  cancelAll(request: CancelAllRequest): Promise<ActionResult>;
}
