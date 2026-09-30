/**
 * Fakes for the actions layer.
 *
 * The fake venue is the important one, and it is deliberately BLUNT: it records
 * what it was asked and answers with whatever the test programmed, including
 * throwing. It does not simulate Perpl. The one behaviour it does model is the
 * one that matters — {@link FakeVenue.applyOnSend}, which moves the position
 * while reporting failure, because that is what a real `t: 6` does and no test of
 * this layer is worth anything unless it faces that.
 */
import {
  ActionTimeoutError,
  ForwardingNotAllowedError,
  NotImplementedError,
  type ActionAvailability,
  type ActionResult,
  type AddMarginRequest,
  type ClosePositionRequest,
  type FeedHealth,
  type MarketRiskConfig,
  type PositionSourceStatus,
  type ReducePositionRequest,
  type RiskPosition,
  type Side,
  type Unsubscribe,
} from '@perpguard/shared';
import type { PriceGate } from '../ingest/marketFeed.ts';
import type {
  ActingVenue,
  PositionReader,
  PriceGateSource,
  ReconcilablePosition,
} from './types.ts';

export const VENUE = 'perpl';

/** A position the tests move around. Integers only, like the real reader. */
export function position(overrides: Partial<ReconcilablePosition> = {}): ReconcilablePosition {
  return {
    marketId: 16,
    symbol: 'BTC',
    positionId: 4242,
    side: 'long' as Side,
    // The live testnet micro from docs/evidence.md: 0.0557 AUSD of margin.
    marginCNS: 55_700n,
    sizeLNS: 1n,
    ...overrides,
  };
}

/**
 * A position reader the test drives.
 *
 * `set` fires the change notification, which is how the executor learns the
 * position moved — the same event the real source emits on an `mt: 27`.
 */
export class FakePositions implements PositionReader {
  #byMarket = new Map<number, ReconcilablePosition>();
  #status: PositionSourceStatus = { state: 'live', lastUpdateMs: 1_000_000, ageMs: 5 };
  readonly #listeners = new Set<() => void>();
  /** Every read, so a test can assert the before-figure was re-read. */
  readonly reads: number[] = [];

  constructor(positions: readonly ReconcilablePosition[] = [position()]) {
    for (const p of positions) this.#byMarket.set(p.marketId, p);
  }

  read(marketId: number): ReconcilablePosition | undefined {
    this.reads.push(marketId);
    return this.#byMarket.get(marketId);
  }

  status(): PositionSourceStatus {
    return this.#status;
  }

  onChange(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Replace a position and notify, as a real update would. */
  set(next: ReconcilablePosition): void {
    this.#byMarket.set(next.marketId, next);
    this.#emit();
  }

  /** Move one field, the way a credited top-up or a fill does. */
  patch(marketId: number, patch: Partial<ReconcilablePosition>): void {
    const existing = this.#byMarket.get(marketId);
    if (existing === undefined) throw new Error(`no position on market ${marketId}`);
    this.set({ ...existing, ...patch });
  }

  /** Drop a position out of the set, as a close or a liquidation does. */
  remove(marketId: number): void {
    this.#byMarket.delete(marketId);
    this.#emit();
  }

  setStatus(status: PositionSourceStatus): void {
    this.#status = status;
    this.#emit();
  }

  /** Change the set without notifying: a missed `mt: 27`. */
  silently(mutate: (byMarket: Map<number, ReconcilablePosition>) => void): void {
    mutate(this.#byMarket);
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** A price gate the test opens and closes. */
export class FakePrices implements PriceGateSource {
  gate: PriceGate = { ok: true, feed: 'connected', ageMs: 120, priceIsOld: false };

  canAct(_marketId: number): PriceGate {
    return this.gate;
  }

  close(reason: string): void {
    this.gate = {
      ok: false,
      code: 'feed-disconnected',
      reason,
      feed: 'disconnected',
      ageMs: 9_000,
      priceIsOld: true,
    };
  }
}

export interface SendRecord {
  readonly kind: 'add-margin' | 'reduce-position' | 'close-position';
  readonly idempotencyKey: string;
  readonly symbol: string;
  readonly positionId: number | undefined;
  readonly amountCNS: bigint | undefined;
  readonly size: number | undefined;
}

/**
 * A venue the test programs.
 *
 * `sends` is the assertion that matters most in this file: the tests about not
 * re-sending are all "assert sends.length === 1", and there is no gentler way to
 * state that requirement.
 */
export class FakeVenue implements ActingVenue {
  readonly network = { name: 'testnet' as const };
  readonly sends: SendRecord[] = [];

  available: ActionAvailability = { actionable: true, network: 'testnet', marketId: 16 };
  availabilityError: Error | undefined;
  feed: FeedHealth = { state: 'connected', reconnectAttempt: 0 };

  /** What `addMargin` answers with. A thrown value is thrown. */
  addMarginResult: ActionResult | Error = rejected('st: 7 Failed, sr: 32 OrderDescIdTooLow');
  reduceResult: ActionResult | Error = new NotImplementedError(VENUE, 'reducePosition');
  closeResult: ActionResult | Error = new NotImplementedError(VENUE, 'closePosition');

  /**
   * Called on every send, before the result is returned or thrown.
   *
   * THE POINT OF THIS CLASS. A real `t: 6` credits the collateral and then reports
   * failure, so a test of the reconciliation has to be able to do both in that
   * order. Set this to move the position.
   */
  applyOnSend: ((record: SendRecord) => void) | undefined;

  async getActionAvailability(_symbol: string): Promise<ActionAvailability> {
    if (this.availabilityError !== undefined) throw this.availabilityError;
    return this.available;
  }

  feedStatus(): FeedHealth {
    return this.feed;
  }

  async addMargin(request: AddMarginRequest): Promise<ActionResult> {
    return this.#send(
      {
        kind: 'add-margin',
        idempotencyKey: request.idempotencyKey,
        symbol: request.symbol,
        positionId: request.positionId,
        amountCNS: request.amountCNS,
        size: undefined,
      },
      this.addMarginResult,
    );
  }

  async reducePosition(request: ReducePositionRequest): Promise<ActionResult> {
    return this.#send(
      {
        kind: 'reduce-position',
        idempotencyKey: request.idempotencyKey,
        symbol: request.symbol,
        positionId: undefined,
        amountCNS: undefined,
        size: request.size,
      },
      this.reduceResult,
    );
  }

  async closePosition(request: ClosePositionRequest): Promise<ActionResult> {
    return this.#send(
      {
        kind: 'close-position',
        idempotencyKey: request.idempotencyKey,
        symbol: request.symbol,
        positionId: undefined,
        amountCNS: undefined,
        size: undefined,
      },
      this.closeResult,
    );
  }

  #send(record: SendRecord, outcome: ActionResult | Error): ActionResult {
    this.sends.push(record);
    // Applied FIRST, then the answer — the real order of events for a `t: 6`.
    this.applyOnSend?.(record);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

/** The `mt: 24` a top-up really produces: failed, with the collateral credited. */
export function rejected(reason: string, venueRef = '4365423542272'): ActionResult {
  return {
    status: 'rejected',
    idempotencyKey: 'k',
    venue: 'perpl',
    network: 'testnet',
    symbol: 'BTC',
    venueRef,
    reason,
    at: 1_000_000,
  };
}

export function confirmed(venueRef = '4312362647552'): ActionResult {
  return {
    status: 'confirmed',
    idempotencyKey: 'k',
    venue: 'perpl',
    network: 'testnet',
    symbol: 'BTC',
    venueRef,
    at: 1_000_000,
  };
}

/** The error the venue throws when no `mt: 24` arrives. Not a failure. */
export function timedOut(waitedMs = 30_000): ActionTimeoutError {
  return new ActionTimeoutError(VENUE, `no outcome within ${waitedMs}ms`, {
    idempotencyKey: 'k',
    stage: 'result',
    waitedMs,
    venueRef: '4365423542272',
  });
}

export function forwardingBlocked(): ForwardingNotAllowedError {
  return new ForwardingNotAllowedError(
    'account 710 does not allow API-key-forwarded orders (`fw` is false).',
    { accountId: 710, network: 'testnet' },
  );
}

/** A collector for the executor's log lines. */
export class RecordingLogger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

// ── kill-switch fixtures ────────────────────────────────────────────────────

export const BTC: MarketRiskConfig = {
  marketId: 1,
  symbol: 'BTC',
  priceDecimals: 1,
  lotDecimals: 5,
  collateralDecimals: 6,
  maintenanceMargin: 2500,
  initialMargin: 1500,
};

export const ETH: MarketRiskConfig = {
  marketId: 20,
  symbol: 'ETH',
  priceDecimals: 2,
  lotDecimals: 3,
  collateralDecimals: 6,
  maintenanceMargin: 2000,
  initialMargin: 1000,
};

export const SOL: MarketRiskConfig = {
  marketId: 31,
  symbol: 'SOL',
  priceDecimals: 3,
  lotDecimals: 2,
  collateralDecimals: 6,
  maintenanceMargin: 2000,
  initialMargin: 1000,
};

export const KILL_CONFIGS = new Map([
  [BTC.marketId, BTC],
  [ETH.marketId, ETH],
  [SOL.marketId, SOL],
]);

/** A risk position in raw integers, for the kill-switch plan. */
export function riskPosition(overrides: Partial<RiskPosition> = {}): RiskPosition {
  return {
    marketId: BTC.marketId,
    symbol: 'BTC',
    side: 'long',
    lotLNS: 50_000n,
    entryPricePNS: 840_295n,
    depositCNS: 2_810_330_000n,
    fundingCNS: 0n,
    ...overrides,
  };
}
