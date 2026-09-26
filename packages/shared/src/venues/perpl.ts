import { z } from 'zod';
import type { NetworkConfig } from '../config.ts';
import { NotImplementedError, VenueError, VenueRequestError } from '../errors.ts';
import { maintenanceMarginRatioFromConfig, maxLeverageFromConfig } from '../units.ts';
import { ContextSchema, type PerplContext, type PerplMarket } from './perpl-context.ts';
import {
  buildCancelFrame,
  buildLimitOrderFrame,
  computeLastExecBlock,
  matchPlacement,
  scaleLimitOrder,
  type OrderIntent,
  type OrderRequestFrame,
  type OrderUpdateEntry,
} from './perpl-orders.ts';
import type { ApiSecret } from './perpl-signing.ts';
import { PerplTradingSocket, type Logger } from './perpl-trading-socket.ts';
import type {
  ActionAvailability,
  ActionResult,
  AddMarginRequest,
  CancelAllRequest,
  CancelOrderRequest,
  ClosePositionRequest,
  PlaceLimitOrderRequest,
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
  /**
   * API-key credentials. Required for anything that submits: without them the
   * venue can read markets and answer availability, and nothing else.
   */
  readonly credentials?: { readonly apiKey: string; readonly secret: ApiSecret };
  /** Where the executor narrates submissions. Silent when absent. */
  readonly logger?: Logger;
  /** Dump every websocket frame. */
  readonly verbose?: boolean;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * How many blocks of the market's TTL to give up as a safety margin.
 *
 * The head block we hold comes from the last heartbeat, so it is always at
 * least slightly behind. Shortening `lb` errs toward an order that expires
 * early, which is recoverable; overshooting `head + order_ttl_blocks` gets the
 * frame rejected outright with "last exec block too high".
 */
const LAST_EXEC_BLOCK_SAFETY = 2;

export class PerplVenue implements Venue {
  readonly id = VENUE_ID;
  readonly network: NetworkConfig;

  readonly #timeoutMs: number;
  readonly #contextTtlMs: number;
  readonly #readOnly: boolean;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  readonly #options: PerplVenueOptions;

  #cached: { context: PerplContext; fetchedAtMs: number } | undefined;
  #inFlight: Promise<PerplContext> | undefined;
  #socket: PerplTradingSocket | undefined;

  constructor(network: NetworkConfig, options: PerplVenueOptions = {}) {
    this.network = network;
    this.#options = options;
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

  /**
   * The authenticated trading socket, connected on first use.
   *
   * Exposed because a caller sometimes needs the session state directly — the
   * account id it discovered, or the head block — but every submission goes
   * through #execute below rather than touching it.
   */
  async connectTrading(): Promise<PerplTradingSocket> {
    if (this.#socket !== undefined) return this.#socket;

    const credentials = this.#options.credentials;
    if (credentials === undefined) {
      throw new VenueError(
        VENUE_ID,
        'no API credentials configured — this venue can read markets but cannot submit anything',
      );
    }
    if (this.#readOnly) {
      throw new VenueError(
        VENUE_ID,
        `this venue is connected to ${this.network.name} for analytics only and never submits`,
      );
    }

    const socket = new PerplTradingSocket({
      network: this.network,
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
      ...(this.#options.verbose === undefined ? {} : { verbose: this.#options.verbose }),
    });
    await socket.connect();
    this.#socket = socket;
    return socket;
  }

  /** Close the trading socket, if one was opened. */
  disconnect(): void {
    this.#socket?.close();
    this.#socket = undefined;
  }

  /**
   * The one path every state-changing action takes.
   *
   * Builds nothing itself — the caller supplies a frame from perpl-orders.ts —
   * so week 3's addMargin (`t: 6`) and closePosition (`t: 3`/`4`) reuse this
   * unchanged. It resolves only on the `mt: 24` outcome; the `mt: 3`
   * acknowledgement goes to `onForwarded`, which cannot be mistaken for
   * completion, and a timeout throws rather than resolving.
   */
  async #execute(params: {
    frame: OrderRequestFrame;
    intent: OrderIntent;
    idempotencyKey: string;
    symbol: string;
    matches: (order: OrderUpdateEntry) => boolean;
    onForwarded?: ((ack: ActionResult) => void) | undefined;
    timeoutMs?: number | undefined;
  }): Promise<ActionResult> {
    const socket = await this.connectTrading();

    const base = {
      idempotencyKey: params.idempotencyKey,
      venue: VENUE_ID,
      network: this.network.name,
      symbol: params.symbol,
    } as const;

    const result = await socket.submit({
      frame: params.frame,
      intent: params.intent,
      idempotencyKey: params.idempotencyKey,
      matches: params.matches,
      ...(params.timeoutMs === undefined ? {} : { resultTimeoutMs: params.timeoutMs }),
      onForwarded: () => {
        params.onForwarded?.({
          ...base,
          // Forwarded is NOT success: accepted for forwarding, nothing more.
          status: 'forwarded',
          at: this.#now(),
        });
      },
    });

    const venueRef = result.orderId === undefined ? undefined : String(result.orderId);
    if (result.outcome === 'confirmed') {
      return {
        ...base,
        status: 'confirmed',
        at: this.#now(),
        ...(venueRef === undefined ? {} : { venueRef }),
      };
    }
    return {
      ...base,
      status: 'rejected',
      reason: result.reason,
      at: this.#now(),
      ...(venueRef === undefined ? {} : { venueRef }),
    };
  }

  /** Throws unless this venue can act on `symbol` right now. */
  async #requireActionable(symbol: string): Promise<VenueMarket> {
    const availability = await this.getActionAvailability(symbol);
    if (!availability.actionable) {
      throw new VenueError(VENUE_ID, availability.reason);
    }
    const market = (await this.getMarkets()).find((m) => m.symbol === symbol);
    if (market === undefined) {
      throw new VenueError(VENUE_ID, `${symbol} is not listed on Perpl ${this.network.name}`);
    }
    return market;
  }

  /**
   * The head block `lb` is computed from. Prefers the live heartbeat; falls
   * back to the context's gas stats, which are a REST snapshot and therefore
   * older — only ever making `lb` shorter, never over the TTL ceiling.
   */
  async #headBlock(socket: PerplTradingSocket): Promise<number> {
    const live = socket.headBlock;
    if (live !== undefined) return live;

    const context = await this.getContext();
    const seeded = context.chain.gas?.h;
    if (seeded === undefined) {
      throw new VenueError(
        VENUE_ID,
        'no head block available from either the heartbeat or the context; ' +
          'cannot compute a last execution block',
      );
    }
    this.#options.logger?.warn(
      `no heartbeat yet — seeding the head block from GET /v1/pub/context (${seeded}), ` +
        `which is already a little stale`,
    );
    return seeded;
  }

  async placeLimitOrder(request: PlaceLimitOrderRequest): Promise<ActionResult> {
    const market = await this.#requireActionable(request.symbol);
    const socket = await this.connectTrading();

    const accountId = socket.accountId;
    if (accountId === undefined) {
      throw new VenueError(
        VENUE_ID,
        'no account id: the WalletSnapshot carried none, so this key has no on-chain account ' +
          'on this network yet',
      );
    }

    const scaled = scaleLimitOrder(market, {
      side: request.side,
      price: request.price,
      size: request.size,
      leverage: request.leverage,
    });
    const frame = buildLimitOrderFrame({
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      marketId: market.marketId,
      accountId,
      side: request.side,
      priceScaled: scaled.priceScaled,
      sizeScaled: scaled.sizeScaled,
      leverageHundredths: scaled.leverageHundredths,
      postOnly: request.postOnly ?? true,
      lastExecBlock: computeLastExecBlock(
        await this.#headBlock(socket),
        market.orderTtlBlocks,
        LAST_EXEC_BLOCK_SAFETY,
      ),
    });

    return this.#execute({
      frame,
      intent: 'place',
      idempotencyKey: request.idempotencyKey,
      symbol: request.symbol,
      matches: matchPlacement(frame, socket.knownOrderIds),
      onForwarded: request.onForwarded,
      timeoutMs: request.timeoutMs,
    });
  }

  async cancelOrder(request: CancelOrderRequest): Promise<ActionResult> {
    const market = await this.#requireActionable(request.symbol);
    const socket = await this.connectTrading();

    const accountId = socket.accountId;
    if (accountId === undefined) {
      throw new VenueError(VENUE_ID, 'no account id; cannot cancel');
    }

    const orderId = Number(request.venueOrderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      throw new VenueError(
        VENUE_ID,
        `venueOrderId must be a positive integer order id, got ${JSON.stringify(request.venueOrderId)}`,
      );
    }

    const frame = buildCancelFrame({
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      marketId: market.marketId,
      accountId,
      orderId,
      lastExecBlock: computeLastExecBlock(
        await this.#headBlock(socket),
        market.orderTtlBlocks,
        LAST_EXEC_BLOCK_SAFETY,
      ),
    });

    return this.#execute({
      frame,
      intent: 'cancel',
      idempotencyKey: request.idempotencyKey,
      symbol: request.symbol,
      // A cancel is unambiguous: the update we want is for that order id.
      matches: (order) => order['id'] === orderId,
      onForwarded: request.onForwarded,
      timeoutMs: request.timeoutMs,
    });
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
    orderTtlBlocks: market.order_ttl_blocks,
    isOpen: config.is_open,
  };
}
