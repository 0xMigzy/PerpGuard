import { z } from 'zod';
import type { NetworkConfig } from '../config.ts';
import { NotImplementedError, VenueRequestError } from '../errors.ts';
import { maintenanceMarginRatioFromConfig, maxLeverageFromConfig } from '../units.ts';
import { ContextSchema, type PerplContext, type PerplMarket } from './perpl-context.ts';
import type {
  ActionAvailability,
  ActionResult,
  AddMarginRequest,
  CancelAllRequest,
  ClosePositionRequest,
  PriceUpdate,
  ReducePositionRequest,
  Unsubscribe,
  Venue,
  VenueMarket,
  VenuePosition,
} from './types.ts';

const VENUE_ID = 'perpl' as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_TTL_MS = 60_000;

export interface PerplVenueOptions {
  /** Timeout for REST calls. */
  readonly timeoutMs?: number;
  /** How long a fetched context is reused before refetching. */
  readonly contextTtlMs?: number;
  /**
   * Mark this venue as analytics-only, so getActionAvailability refuses every
   * market. Set it on the mainnet venue: reads may run against mainnet, actions
   * never do.
   */
  readonly readOnly?: boolean;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export class PerplVenue implements Venue {
  readonly id = VENUE_ID;
  readonly network: NetworkConfig;

  readonly #timeoutMs: number;
  readonly #contextTtlMs: number;
  readonly #readOnly: boolean;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  #cached: { context: PerplContext; fetchedAtMs: number } | undefined;
  #inFlight: Promise<PerplContext> | undefined;

  constructor(network: NetworkConfig, options: PerplVenueOptions = {}) {
    this.network = network;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#contextTtlMs = options.contextTtlMs ?? DEFAULT_CONTEXT_TTL_MS;
    this.#readOnly = options.readOnly ?? false;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  /**
   * GET /v1/pub/context — the source of truth for market ids, scaling and
   * margin requirements, none of which may be hard-coded.
   *
   * Cached for contextTtlMs, and de-duplicated so concurrent callers share a
   * single request.
   */
  async getContext(options: { force?: boolean } = {}): Promise<PerplContext> {
    const cached = this.#cached;
    if (
      options.force !== true &&
      cached !== undefined &&
      this.#now() - cached.fetchedAtMs < this.#contextTtlMs
    ) {
      return cached.context;
    }

    this.#inFlight ??= this.#fetchContext().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  /** Drop the cached context so the next read refetches. */
  refresh(): void {
    this.#cached = undefined;
  }

  async #fetchContext(): Promise<PerplContext> {
    const url = `${this.network.restBaseUrl}/v1/pub/context`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new VenueRequestError(VENUE_ID, url, `request to ${url} failed`, { cause });
    }

    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200);
      const detail = body === '' ? '' : `: ${body}`;
      throw new VenueRequestError(
        VENUE_ID,
        url,
        `context returned ${response.status} ${response.statusText}${detail}`,
        { status: response.status },
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new VenueRequestError(VENUE_ID, url, 'context response was not valid JSON', { cause });
    }

    const parsed = ContextSchema.safeParse(json);
    if (!parsed.success) {
      throw new VenueRequestError(
        VENUE_ID,
        url,
        `context did not match the expected shape: ${z.prettifyError(parsed.error)}`,
      );
    }

    const context = parsed.data;
    if (context.chain.chain_id !== this.network.chainId) {
      throw new VenueRequestError(
        VENUE_ID,
        url,
        `expected chain ${this.network.chainId} for ${this.network.name}, context reports ${context.chain.chain_id}`,
      );
    }

    this.#cached = { context, fetchedAtMs: this.#now() };
    return context;
  }

  async getMarkets(): Promise<VenueMarket[]> {
    const context = await this.getContext();
    return context.markets.map((market) => toVenueMarket(market, this.network.name));
  }

  /**
   * Whether actions for `symbol` can be sent on this venue's network.
   *
   * Not every asset exists on both networks — HYPE and VVV are mainnet-only —
   * and a market can be closed. Either way the answer only gates action
   * controls; the risk engine keeps monitoring and alerting on the position.
   */
  async getActionAvailability(symbol: string): Promise<ActionAvailability> {
    const network = this.network.name;

    if (this.#readOnly) {
      return {
        actionable: false,
        network,
        code: 'venue-read-only',
        reason: `This venue is connected to Perpl ${network} for analytics only, so it never sends actions.`,
      };
    }

    const markets = await this.getMarkets();
    const market = markets.find((m) => m.symbol === symbol);

    if (market === undefined) {
      return {
        actionable: false,
        network,
        code: 'not-listed-on-acting-network',
        reason: `${symbol} is not listed on Perpl ${network}, so there is nothing to act on there. Monitoring and alerts continue.`,
      };
    }

    if (!market.isOpen) {
      return {
        actionable: false,
        network,
        code: 'market-closed',
        reason: `${symbol} is currently closed on Perpl ${network}. Monitoring and alerts continue.`,
      };
    }

    return { actionable: true, network, marketId: market.marketId };
  }

  /**
   * Collateral token as the venue reports it, resolved through the protocol
   * instance collateral_token_id rather than assuming 6 decimals.
   */
  async getCollateralToken(): Promise<{ symbol: string; decimals: number; address: string }> {
    const context = await this.getContext();
    const instance = context.instances[0];
    const token =
      context.tokens.find((t) => t.id === instance?.collateral_token_id) ?? context.tokens[0];

    if (token === undefined) {
      return {
        symbol: 'AUSD',
        decimals: this.network.collateralDecimals,
        address: this.network.collateralAddress,
      };
    }
    return { symbol: token.symbol, decimals: token.decimals, address: token.address };
  }

  // Not implemented yet. These reject rather than resolving to a neutral value,
  // so no caller can mistake an unbuilt path for a successful action.

  getPositions(_address: string): Promise<VenuePosition[]> {
    // Needs the authenticated account endpoint plus an Ed25519 API key.
    return Promise.reject(new NotImplementedError(VENUE_ID, 'getPositions'));
  }

  subscribePrices(
    _symbols: readonly string[],
    _onUpdate: (update: PriceUpdate) => void,
  ): Promise<Unsubscribe> {
    // wss://<host>/ws/v1/market-data: subscribe with
    // {mt: 5, subs: [{stream: "market-state@<chainId>", subscribe: true}]},
    // updates arrive as mt: 9 carrying orl/mrk/lst/mid/bid/ask as scaled ints.
    return Promise.reject(new NotImplementedError(VENUE_ID, 'subscribePrices'));
  }

  addMargin(_request: AddMarginRequest): Promise<ActionResult> {
    return Promise.reject(new NotImplementedError(VENUE_ID, 'addMargin'));
  }

  reducePosition(_request: ReducePositionRequest): Promise<ActionResult> {
    return Promise.reject(new NotImplementedError(VENUE_ID, 'reducePosition'));
  }

  closePosition(_request: ClosePositionRequest): Promise<ActionResult> {
    return Promise.reject(new NotImplementedError(VENUE_ID, 'closePosition'));
  }

  cancelAll(_request: CancelAllRequest): Promise<ActionResult> {
    return Promise.reject(new NotImplementedError(VENUE_ID, 'cancelAll'));
  }
}

/** Pure mapping from the venue market shape to ours. Exported for tests. */
export function toVenueMarket(market: PerplMarket, network: VenueMarket['network']): VenueMarket {
  const config = market.config;
  return {
    venue: VENUE_ID,
    network,
    marketId: market.id,
    instanceId: market.instance_id,
    // size_units, not name: 'BTC' on mainnet vs 'BTC Perp' on testnet.
    symbol: market.size_units,
    displayName: market.name,
    priceDecimals: config.price_decimals,
    sizeDecimals: config.size_decimals,
    maxLeverage: maxLeverageFromConfig(config.initial_margin),
    maintenanceMarginRatio: maintenanceMarginRatioFromConfig(config.maintenance_margin),
    makerFeeMicros: config.maker_fee,
    takerFeeMicros: config.taker_fee,
    fundingIntervalSec: market.funding_interval_sec,
    isOpen: config.is_open,
  };
}
