import { z } from 'zod';
import type { NetworkConfig } from '../config.ts';
import { NotImplementedError, VenueError, VenueRequestError } from '../errors.ts';
import type { MarketRiskConfig } from '../risk/position.ts';
import {
  maintenanceMarginRatioFromConfig,
  maxLeverageFromConfig,
  scaledToNumber,
  type RawAmount,
} from '../units.ts';
import { ContextSchema, type PerplContext, type PerplMarket } from './perpl-context.ts';
import { assertForwardingAllowed } from './perpl-forwarding.ts';
import {
  PerplMarketDataSocket,
  toMarketDescriptor,
  type FeedEvent,
} from './perpl-market-data.ts';
import {
  buildAddMarginFrame,
  buildClosePositionFrame,
  buildCancelFrame,
  buildLimitOrderFrame,
  computeLastExecBlock,
  matchPlacement,
  orderIdOf,
  scaleLimitOrder,
  type OrderIntent,
  type OrderRequestFrame,
  type OrderUpdateEntry,
} from './perpl-orders.ts';
import {
  parsePositionFrame,
  type PerplPosition,
  type PositionEntry,
} from './perpl-positions.ts';
import type { ApiSecret } from './perpl-signing.ts';
import type { Logger } from './perpl-socket.ts';
import { PerplTradingSocket } from './perpl-trading-socket.ts';
import type {
  ActionAvailability,
  ActionResult,
  AddMarginRequest,
  FeedHealth,
  CancelAllRequest,
  MarketOpenInterest,
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
  /** Injectable for tests, forwarded to the trading socket. */
  readonly webSocketImpl?: typeof WebSocket;
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
  #marketData: PerplMarketDataSocket | undefined;
  #marketDataStarting: Promise<PerplMarketDataSocket> | undefined;
  /** Live subscribePrices callers. The shared feed closes when it hits zero. */
  #priceSubscribers = 0;

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

  async getOpenInterest(): Promise<readonly MarketOpenInterest[]> {
    const context = await this.getContext();
    return context.markets.map((market) => toOpenInterest(market, this.network.name));
  }

  /**
   * Whether actions for `symbol` can be sent on this venue's network.
   *
   * Not every asset exists on both networks — HYPE and VVV are mainnet-only —
   * and a market can be closed. Either way the answer only gates action
   * controls; the risk engine keeps monitoring and alerting on the position.
   */
  /**
   * Risk configs off the RAW context, keyed by market id.
   *
   * `config.initial_margin` and `config.maintenance_margin` are passed through
   * untouched: the risk engine wants the venue's own integers, and recovering
   * them from `VenueMarket`'s derived ratios would mean inverting a float.
   *
   * `collateralDecimals` comes from the context `tokens[]` entry, never assumed
   * to be 6.
   */
  async getRiskConfigs(): Promise<ReadonlyMap<number, MarketRiskConfig>> {
    const [context, collateral] = await Promise.all([
      this.getContext(),
      this.getCollateralToken(),
    ]);
    const configs = new Map<number, MarketRiskConfig>();
    for (const market of context.markets) {
      configs.set(market.id, {
        marketId: market.id,
        symbol: market.size_units,
        priceDecimals: market.config.price_decimals,
        lotDecimals: market.config.size_decimals,
        collateralDecimals: collateral.decimals,
        maintenanceMargin: market.config.maintenance_margin,
        initialMargin: market.config.initial_margin,
      });
    }
    return configs;
  }

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
      ...(this.#options.webSocketImpl === undefined
        ? {}
        : { webSocketImpl: this.#options.webSocketImpl }),
    });
    await socket.connect();
    this.#socket = socket;
    return socket;
  }

  /**
   * A FLOOR on the account's spendable AUSD, in micros, or undefined when we do
   * not know — no trading socket, or no account snapshot on it yet.
   *
   * SYNCHRONOUS, and undefined rather than awaited, for the same reason
   * {@link feedStatus} is: something about to tell a trader what they can afford
   * must not have to open a socket to find out, and "we have not been told" is a
   * real answer that has to be representable.
   *
   * It is a FLOOR, not the balance. See `freeBalanceFloorCNS` on the trading
   * socket for why `b - lb` is the most that can be asserted today, and why a
   * caller must say "at least" and must not refuse an amount for exceeding it.
   */
  freeBalanceFloorCNS(): bigint | undefined {
    return this.#socket?.freeBalanceFloorCNS;
  }

  /** Close both sockets, if they were opened. */
  disconnect(): void {
    this.#socket?.close();
    this.#socket = undefined;
    this.#marketData?.close();
    this.#marketData = undefined;
    this.#priceSubscribers = 0;
  }

  /**
   * The shared market-data feed, started on first use.
   *
   * One connection serves every subscriber: `market-state@<chainId>` already
   * carries all markets in a single frame, and the docs cap us at five
   * connections per IP. Concurrent callers share one start, the way
   * getContext() shares one fetch.
   */
  async #connectMarketData(): Promise<PerplMarketDataSocket> {
    if (this.#marketData !== undefined) return this.#marketData;

    this.#marketDataStarting ??= (async () => {
      // Every market, not just the requested symbols: the frame carries them
      // all anyway, and ids and price scaling must come from the context.
      const markets = await this.getMarkets();
      const socket = new PerplMarketDataSocket({
        network: this.network,
        markets: markets.map(toMarketDescriptor),
        ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
        ...(this.#options.verbose === undefined ? {} : { verbose: this.#options.verbose }),
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      });
      await socket.start();
      this.#marketData = socket;
      return socket;
    })().finally(() => {
      this.#marketDataStarting = undefined;
    });

    return this.#marketDataStarting;
  }

  /**
   * Connection health of this venue's price feed.
   *
   * Answers "can these prices be trusted at all", which is NOT "how old is
   * this price". A quiet market gives an old price on a healthy feed and is
   * perfectly actionable; a frozen price on a dead feed is not, and only this
   * can tell them apart. Reports disconnected before anything has subscribed,
   * so a caller that forgot to start the feed is never told it is fine.
   */
  feedStatus(): FeedHealth {
    const socket = this.#marketData;
    if (socket === undefined) {
      return {
        state: 'disconnected',
        reason: `no price feed is open for Perpl ${this.network.name}; nothing has subscribed yet`,
        reconnectAttempt: 0,
      };
    }
    return socket.feedStatus();
  }

  /** Observe feed lifecycle events — connects, drops and reconnects. */
  async onFeedEvent(listener: (status: FeedEvent) => void): Promise<Unsubscribe> {
    const socket = await this.#connectMarketData();
    return socket.onEvent(listener);
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

    // Pre-flight, before a frame is sent and before an `rq` is spent. An
    // account with `fw` false is admitted for forwarding and only rejected
    // later on `mt: 24` with sr 34, which tells the user nothing useful and
    // costs a round trip they may not have. Every action reaches this path.
    assertForwardingAllowed({
      forwardingAllowed: socket.forwardingAllowed,
      accountId: socket.accountId,
      network: this.network.name,
    });

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
      // A cancel is unambiguous: the update we want is for that order id. It
      // must be read with orderIdOf — the wire carries `oid`, never `id`, so
      // matching on `id` matches nothing and looks exactly like a timeout.
      matches: (order) => orderIdOf(order) === orderId,
      onForwarded: request.onForwarded,
      timeoutMs: request.timeoutMs,
    });
  }

  /**
   * Stream prices for `symbols` off the public market-data websocket.
   *
   * Works on a read-only venue: market data is public and unauthenticated, and
   * analytics reads mainnet precisely so the demo shows real prices. The feed
   * reconnects on its own, so an Unsubscribe is the only way it stops.
   *
   * An unknown symbol throws rather than going quiet — a ticker that never
   * ticks is indistinguishable from a typo, and silence is the one failure a
   * risk monitor must never have.
   */
  async subscribePrices(
    symbols: readonly string[],
    onUpdate: (update: PriceUpdate) => void,
  ): Promise<Unsubscribe> {
    if (symbols.length === 0) {
      throw new VenueError(VENUE_ID, 'subscribePrices needs at least one symbol');
    }

    const markets = await this.getMarkets();
    const listed = new Set(markets.map((m) => m.symbol));
    const missing = symbols.filter((symbol) => !listed.has(symbol));
    if (missing.length > 0) {
      throw new VenueError(
        VENUE_ID,
        `not listed on Perpl ${this.network.name}: ${missing.join(', ')}. ` +
          `Available: ${[...listed].sort().join(', ')}`,
      );
    }

    const wanted = new Set(symbols);
    const socket = await this.#connectMarketData();
    const off = socket.onPrice((update) => {
      if (wanted.has(update.symbol)) onUpdate(update);
    });
    this.#priceSubscribers += 1;

    let live = true;
    return () => {
      if (!live) return;
      live = false;
      off();
      this.#priceSubscribers -= 1;
      if (this.#priceSubscribers <= 0) {
        this.#marketData?.close();
        this.#marketData = undefined;
        this.#priceSubscribers = 0;
      }
    };
  }

  // Not implemented yet. These reject rather than resolving to a neutral value,
  // so no caller can mistake an unbuilt path for a successful action.

  /**
   * Open positions for `address`, live off the authenticated trading socket.
   *
   * ONLY FOR THE SIGNED-IN WALLET. An API key is bound to one account, so this
   * socket can only ever answer for that one. Any other address THROWS rather
   * than returning what it does have: silently answering with our own account's
   * positions would be a risk tool lying about whose money is at stake.
   *
   * POSITIONS FOR ARBITRARY WALLETS ARE A DIFFERENT QUESTION WITH A DIFFERENT
   * SOURCE. They come from indexed chain data through the venue-agnostic
   * analytics interface, which can see every account because it reads the
   * chain rather than an authenticated session. Do not let the two get
   * conflated: this one is live, authenticated and ours; that one is
   * historical, public and anyone's.
   */
  async getPositions(address: string): Promise<VenuePosition[]> {
    const socket = await this.connectTrading();
    const signedInAs = socket.walletAddress;
    const wanted = address.trim().toLowerCase();

    if (signedInAs === undefined) {
      throw new VenueError(
        VENUE_ID,
        'the WalletSnapshot carried no wallet address, so there is no way to check that ' +
          `${address} is the account this key signs for. Refusing to answer rather than ` +
          'guess whose positions these are.',
      );
    }
    if (wanted !== signedInAs) {
      throw new VenueError(
        VENUE_ID,
        `this API key signs for ${signedInAs}, not ${address}. An API key is bound to one ` +
          'account, so this socket cannot answer for another wallet. For positions belonging ' +
          'to an arbitrary address, use the analytics interface over indexed chain data.',
      );
    }

    const untrustworthy = socket.positionsUntrustworthyReason;
    if (untrustworthy !== undefined) {
      throw new VenueError(
        VENUE_ID,
        `cannot report positions: ${untrustworthy}. Returning the set we hold would present ` +
          'a possibly stale view as current.',
      );
    }

    return this.#decodePositions(socket.positions);
  }

  /** Raw position rows -> venue-agnostic positions, using context scaling. */
  async #decodePositions(rows: readonly PositionEntry[]): Promise<PerplPosition[]> {
    const markets = new Map((await this.getMarkets()).map((m) => [m.marketId, m]));
    const collateral = await this.getCollateralToken();
    const decoded = parsePositionFrame(rows, markets, this.network.name, collateral.decimals);

    for (const marketId of decoded.skipped) {
      // A market listed on chain but absent from the context is real (mainnet
      // TAO). Say so rather than dropping a position silently.
      this.#options.logger?.warn(
        `position on market ${marketId}, which Perpl ${this.network.name} does not list in ` +
          `GET /v1/pub/context — cannot scale it, so it is not reported`,
      );
    }
    return decoded.open;
  }

  /**
   * Add collateral to one position — `t: 6` IncreasePositionCollateral.
   *
   * THE RESULT THIS RETURNS IS WHAT THE VENUE SAID, NOT WHAT HAPPENED. A `t: 6`
   * comes back `st: 7 Failed, sr: 32 OrderDescIdTooLow` while the collateral is
   * credited in full — measured four times across three testnet runs, recorded in
   * `docs/evidence.md`. So this resolves `rejected` on the normal successful
   * path, and the caller MUST reconcile against the position's own margin rather
   * than believing it. `ADD_MARGIN_STATUS_CAVEAT` is appended to the reason so
   * the warning travels with the status.
   *
   * It stays that way deliberately rather than being papered over here: this
   * class's job is to report the venue faithfully, and a venue adapter that
   * quietly rewrote a failure into a success would be the more dangerous of the
   * two mistakes. The reconciliation lives in `apps/backend/src/actions`, which
   * is the layer that can see the position before and after.
   *
   * A TIMEOUT THROWS, as everywhere else, and is equally not a failure. Never
   * re-send either one: doing exactly that during the investigation added the
   * margin twice.
   */
  async addMargin(request: AddMarginRequest): Promise<ActionResult> {
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

    const frame = buildAddMarginFrame({
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      marketId: market.marketId,
      accountId,
      positionId: request.positionId,
      amountCNS: request.amountCNS,
      lastExecBlock: computeLastExecBlock(
        await this.#headBlock(socket),
        market.orderTtlBlocks,
        LAST_EXEC_BLOCK_SAFETY,
      ),
    });

    return this.#execute({
      frame,
      intent: 'add-margin',
      idempotencyKey: request.idempotencyKey,
      symbol: request.symbol,
      // The `mt: 24` for a `t: 6` carries our own `rq`, which matchPlacement
      // prefers over every other correlator. Verified against the captured
      // frame in docs/evidence.md.
      matches: matchPlacement(frame, socket.knownOrderIds),
      onForwarded: request.onForwarded,
      timeoutMs: request.timeoutMs,
    });
  }

  /**
   * Close part of a position — `t: 3` CloseLong / `t: 4` CloseShort with `s` less
   * than the whole size.
   *
   * MEASURED, not inferred. 2026-09-30: `s: 1` against a 3-unit long came back
   * `st: 4 Filled, sr: 43 TakerOrderFilled` on `mt: 24` in under a second, and the
   * `mt: 27` showed `st: 1 Open, sr: 14 PositionDecreased` with the SAME `pid` and
   * margin released in proportion — `c` 166576 -> 111051, which is exactly two
   * thirds, with the entry price unchanged. That is the arithmetic behind the rule
   * that a proportional reduce leaves the liquidation price EXACTLY where it was:
   * it buys no room at all, it only slows the bleeding.
   *
   * UNLIKE A TOP-UP, THIS ORDER TYPE TELLS THE TRUTH. `t: 6` reports
   * `st: 7 Failed` while the collateral lands; `t: 3` reported `st: 4 Filled` on
   * every one of the three round trips measured. The actions layer still
   * reconciles against the position's size rather than believing it — the
   * discipline does not get relaxed because one order type has behaved so far —
   * but no caveat is appended to the status here, because none is warranted.
   */
  async reducePosition(request: ReducePositionRequest): Promise<ActionResult> {
    return this.#exitPosition(request, 'reduce');
  }

  /**
   * Close a whole position — the same frame with `s` equal to the whole size.
   *
   * MEASURED, 2026-09-30: `st: 4 Filled, sr: 43` on `mt: 24`, and the `mt: 27`
   * carried `st: 2 Closed, sr: 13 PositionClosed` with `c: "0"` and size 0. The
   * position is DELIVERED AS A ROW, not as an omission — which is why the position
   * decoder drops anything whose `st` is not 1 rather than waiting for it to
   * disappear.
   */
  async closePosition(request: ClosePositionRequest): Promise<ActionResult> {
    return this.#exitPosition(request, 'close');
  }

  /**
   * The shared path for a close and a reduce, because they are one frame.
   *
   * A MARKET EXIT, always: `p: 0` with ImmediateOrCancel. A resting limit exit is
   * not what any of this product's actions want — a kill switch that left orders
   * resting would report "closed" over positions still open, and `order_ttl_blocks`
   * means a resting exit is gone in seconds anyway.
   */
  async #exitPosition(
    request: ReducePositionRequest,
    label: 'reduce' | 'close',
  ): Promise<ActionResult> {
    // FIRST, before a socket is opened and before an `rq` is spent. A size we
    // cannot send is a caller bug, and it costs nothing to say so immediately.
    if (request.sizeLNS <= 0n) {
      throw new VenueError(
        VENUE_ID,
        `a ${label} must name a positive size in the market's own units, got ${request.sizeLNS}`,
      );
    }
    if (request.sizeLNS > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new VenueError(VENUE_ID, `size ${request.sizeLNS} is out of range for a wire frame`);
    }

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

    const frame = buildClosePositionFrame({
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      marketId: market.marketId,
      accountId,
      // The POSITION's side. buildClosePositionFrame maps it to CloseLong /
      // CloseShort; handing it the order's direction would double the position.
      positionSide: request.positionSide,
      positionId: request.positionId,
      sizeScaled: Number(request.sizeLNS),
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
      // The outcome carries our own `rq`, which matchPlacement prefers over every
      // other correlator. Verified on all three measured round trips.
      matches: matchPlacement(frame, socket.knownOrderIds),
      onForwarded: request.onForwarded,
      timeoutMs: request.timeoutMs,
    });
  }

  cancelAll(_request: CancelAllRequest): Promise<ActionResult> {
    return Promise.reject(new NotImplementedError(VENUE_ID, 'cancelAll'));
  }
}

/** Pure mapping from the venue market shape to ours. Exported for tests. */
/**
 * The open-interest reading off one context market.
 *
 * `state.oi` is in size units (the docs pair it with `dv`, "Daily volume
 * (size)"), so it is scaled by `size_decimals`; the mark by `price_decimals`.
 * Both come from the same row, so the notional is that market's own arithmetic
 * and nothing is hard-coded.
 */
export function toOpenInterest(
  market: PerplMarket,
  network: VenueMarket['network'],
): MarketOpenInterest {
  const openInterestSize = scaledToNumber(market.state.oi as RawAmount, market.config.size_decimals);
  const markPrice = scaledToNumber(market.state.mrk as RawAmount, market.config.price_decimals);
  return {
    venue: VENUE_ID,
    network,
    marketId: market.id,
    symbol: market.size_units,
    openInterestSize,
    markPrice,
    openInterestNotional: openInterestSize * markPrice,
    atBlock: market.state.at.b,
    atMs: market.state.at.t,
  };
}

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
