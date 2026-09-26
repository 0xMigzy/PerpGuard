import type { NetworkConfig, NetworkName } from '../config.ts';

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
  readonly isOpen: boolean;
}

export interface VenuePosition {
  readonly venue: VenueId;
  readonly network: NetworkName;
  readonly symbol: string;
  readonly marketId: number;
  readonly side: Side;
  /** Absolute position size in base units. */
  readonly size: number;
  readonly entryPrice: number;
  readonly markPrice: number;
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
}

export interface AddMarginRequest extends ActionRequest {
  /** AUSD to add to this position's isolated margin. */
  readonly amount: number;
}

export interface ReducePositionRequest extends ActionRequest {
  /** Base units to close. */
  readonly size: number;
}

export type ClosePositionRequest = ActionRequest;

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

  /** @param symbols canonical tickers, e.g. ['BTC', 'ETH']. */
  subscribePrices(
    symbols: readonly string[],
    onUpdate: (update: PriceUpdate) => void,
  ): Promise<Unsubscribe>;

  addMargin(request: AddMarginRequest): Promise<ActionResult>;
  reducePosition(request: ReducePositionRequest): Promise<ActionResult>;
  closePosition(request: ClosePositionRequest): Promise<ActionResult>;
  cancelAll(request: CancelAllRequest): Promise<ActionResult>;
}
