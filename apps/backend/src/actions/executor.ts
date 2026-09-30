/**
 * The one path that sends.
 *
 * Read `types.ts` and `reconcile.ts` first; this file is the sequencing, and the
 * judgement lives there. What happens here, in order, and why that order:
 *
 *   1. SYNCHRONOUS PRE-FLIGHT, before a lease is taken. A command with no
 *      position id, a position we do not hold, a set we cannot believe, a feed
 *      that is not connected — all refused without touching anything.
 *   2. CLAIM THE LEASE. Synchronous and atomic, so two callers on one turn cannot
 *      both win. Everything after this is inside a `finally` that releases it.
 *   3. ASK THE ACTING VENUE. Async, and deliberately inside the lease: a
 *      concurrent attempt must be refused while we are waiting on this.
 *   4. CAPTURE THE BEFORE-FIGURE, re-read here rather than reused from step 1,
 *      because step 3 awaited and the position may have moved.
 *   5. OPEN THE `action_log` ROW. Before the send, always. The row that matters
 *      most is the one that never gets a settlement — the action whose process
 *      died between sending and answering — and it only exists if it was written
 *      first.
 *   6. SEND. EXACTLY ONCE. There is no loop, no attempt counter and no retry
 *      branch anywhere in this file.
 *   7. LOOK AT THE POSITION AGAIN, and reconcile against it.
 *   8. SETTLE THE ROW, release the lease.
 *
 * THE VENUE'S ANSWER NEVER DECIDES THE OUTCOME. A `t: 6` top-up resolves
 * `rejected` on its normal successful path — `st: 7 Failed, sr: 32
 * OrderDescIdTooLow`, measured four times with the collateral credited in full —
 * so the reported status is recorded, quoted, and then set aside in favour of the
 * position's own margin. A timeout is treated identically: not a failure, a
 * prompt to look.
 */
import {
  ActionTimeoutError,
  NotImplementedError,
  positionsAreUsable,
  type ActionResult,
  type Unsubscribe,
} from '@perpguard/shared';
import { ForwardingNotAllowedError } from '@perpguard/shared';
import { reconcileAddMargin, reconcileClose, reconcileReduce } from './reconcile.ts';
import { InFlightRegistry, type Lease } from './inflight.ts';
import type {
  ActingVenue,
  ActionCommand,
  ActionLog,
  ActionOutcome,
  PositionReader,
  PriceGateSource,
  Reconciliation,
  ReconcilablePosition,
  RefusalCode,
  ReportedStatus,
  WatchedField,
} from './types.ts';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

const silent: Logger = { info: () => {}, warn: () => {} };

export interface ActionsExecutorOptions {
  readonly venue: ActingVenue;
  readonly positions: PositionReader;
  readonly prices: PriceGateSource;
  readonly log: ActionLog;
  readonly inFlight?: InFlightRegistry;
  /**
   * How long to wait for the position to reflect the action before reconciling
   * against whatever it shows.
   *
   * NOT A DEADLINE FOR THE ACTION — nothing is abandoned when it expires, and
   * nothing is re-sent. It is how long we watch before making a judgement, and
   * expiring simply means the judgement is made on an unchanged position. Monad
   * blocks are ~300ms, so a few seconds is many blocks.
   */
  readonly settleTimeoutMs?: number;
  /** Passed to the venue, which throws ActionTimeoutError rather than resolving. */
  readonly venueTimeoutMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
  /** Injected so the settle wait is testable without real time. */
  readonly setTimeoutImpl?: typeof setTimeout;
  /**
   * Told where an action has got to, so a UI can show the steps AS THEY HAPPEN
   * rather than pretending. `sending` fires just before the one send;
   * `reconciling` fires the moment the venue has answered (or timed out, or
   * thrown) and carries exactly what it reported, which is not the outcome.
   * Nothing here changes what the executor does.
   */
  readonly onProgress?: (progress: ActionProgress) => void;
}

export type ActionProgress =
  | { readonly idempotencyKey: string; readonly stage: 'sending' }
  | { readonly idempotencyKey: string; readonly stage: 'reconciling'; readonly reported: ReportedStatus };

const DEFAULT_SETTLE_TIMEOUT_MS = 8_000;

/** What one look at the position saw. */
interface Observation {
  readonly after: bigint | undefined;
  /** Set when the position set stopped being believable while we watched. */
  readonly untrustedReason: string | undefined;
  readonly waitedMs: number;
  readonly changed: boolean;
}

export class ActionsExecutor {
  readonly #venue: ActingVenue;
  readonly #positions: PositionReader;
  readonly #prices: PriceGateSource;
  readonly #log: ActionLog;
  readonly #inFlight: InFlightRegistry;
  readonly #settleTimeoutMs: number;
  readonly #venueTimeoutMs: number | undefined;
  readonly #now: () => number;
  readonly #logger: Logger;
  readonly #setTimeout: typeof setTimeout;
  readonly #onProgress: ((progress: ActionProgress) => void) | undefined;

  constructor(options: ActionsExecutorOptions) {
    this.#venue = options.venue;
    this.#positions = options.positions;
    this.#prices = options.prices;
    this.#log = options.log;
    this.#inFlight = options.inFlight ?? new InFlightRegistry({ now: options.now ?? Date.now });
    this.#settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    this.#venueTimeoutMs = options.venueTimeoutMs;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? silent;
    this.#setTimeout = options.setTimeoutImpl ?? setTimeout;
    this.#onProgress = options.onProgress;
  }

  /** Whether an action on this market is already in flight. For a UI to grey out. */
  inFlightOn(marketId: number): Lease | undefined {
    return this.#inFlight.held(marketId);
  }

  async execute(command: ActionCommand): Promise<ActionOutcome> {
    const refusal = this.#preflightSync(command);
    if (refusal !== undefined) return refusal;

    const claim = this.#inFlight.claim(command.marketId, command.idempotencyKey);
    if (!claim.ok) {
      return this.#refuse(command, 'already-in-flight', claim.reason);
    }

    try {
      return await this.#run(command);
    } finally {
      this.#inFlight.release(claim.lease);
    }
  }

  /**
   * Every refusal that can be decided without awaiting anything.
   *
   * Kept synchronous as a group so it all happens before a lease is taken and
   * before a row is opened — a refused action should leave no trace but a log
   * line.
   */
  #preflightSync(command: ActionCommand): ActionOutcome | undefined {
    if (command.positionId === undefined) {
      return this.#refuse(
        command,
        'no-position-id',
        `I have no venue position id for ${command.symbol} (market ${command.marketId}), so ` +
          `there is nothing to address this action to. Isolated margin means it has to name one ` +
          `position, and the id cannot be derived from the market.`,
      );
    }
    if (command.kind === 'add-margin' && command.amountCNS <= 0n) {
      return this.#refuse(
        command,
        'invalid-command',
        `a top-up must be a positive amount of AUSD micros, got ${command.amountCNS}.`,
      );
    }
    if (command.kind === 'reduce-position' && command.sizeLNS <= 0n) {
      return this.#refuse(
        command,
        'invalid-command',
        `a reduce must close a positive number of lots, got ${command.sizeLNS}.`,
      );
    }

    // THE SET BEFORE THE POSITION. An untrustworthy set means an absent position
    // proves nothing, so asking "do we hold it" first would produce the wrong
    // refusal — and the wrong refusal here reads as "you have no position".
    const status = this.#positions.status();
    if (!positionsAreUsable(status)) {
      return this.#refuse(
        command,
        'positions-untrusted',
        `the position set is ${status.state}, so I cannot read what ${command.symbol} holds now ` +
          `and would have nothing trustworthy to compare against afterwards. ` +
          `${status.reason ?? ''}`.trim(),
      );
    }

    const position = this.#positions.read(command.marketId);
    if (position === undefined) {
      return this.#refuse(
        command,
        'no-position',
        `I hold no position on ${command.symbol} (market ${command.marketId}), and the position ` +
          `set is live, so there is nothing to act on.`,
      );
    }

    // REFUSE TO ACT WHEN THE FEED IS NOT CONNECTED (CLAUDE.md). Asked through the
    // gate the feed already encodes, so a quiet market — an old price on a
    // healthy feed — stays fully actionable and only a frozen one is refused.
    const gate = this.#prices.canAct(command.marketId);
    if (!gate.ok) {
      return this.#refuse(
        command,
        'feed-down',
        `${gate.reason ?? `prices for ${command.symbol} cannot be acted on`}. The amount was ` +
          `worked out against a mark, and every price I hold is frozen while the feed is ` +
          `${gate.feed}.`,
      );
    }

    return undefined;
  }

  async #run(command: ActionCommand): Promise<ActionOutcome> {
    // Asked of the ACTING venue, which is not the venue a position was read from:
    // analytics runs on mainnet and actions on testnet, and the two do not list
    // the same markets.
    let availabilityReason: string | undefined;
    try {
      const availability = await this.#venue.getActionAvailability(command.symbol);
      if (!availability.actionable) availabilityReason = availability.reason;
    } catch (error) {
      availabilityReason = `I could not check whether ${command.symbol} can be acted on: ${message(error)}`;
    }
    if (availabilityReason !== undefined) {
      return this.#refuse(
        command,
        'not-actionable',
        `not actionable on ${this.#venue.network.name}: ${availabilityReason}`,
      );
    }

    // RE-READ. The availability check awaited, so the figure captured in
    // pre-flight may be one fill out of date, and the before-figure is the whole
    // basis of the verdict.
    const position = this.#positions.read(command.marketId);
    if (position === undefined) {
      return this.#refuse(
        command,
        'no-position',
        `${command.symbol} left the position set while I was checking whether it could be ` +
          `acted on, so there is nothing to act on.`,
      );
    }

    const field = watchedField(command);
    const before = field === 'margin' ? position.marginCNS : position.sizeLNS;
    const requested = requestedAmount(command, position);

    await this.#log.open({
      idempotencyKey: command.idempotencyKey,
      userId: command.userId,
      kind: command.kind,
      marketId: command.marketId,
      symbol: command.symbol,
      positionId: command.positionId,
      network: this.#venue.network.name,
      field,
      requested,
      before,
      openedAtMs: this.#now(),
    });

    this.#onProgress?.({ idempotencyKey: command.idempotencyKey, stage: 'sending' });
    const sent = await this.#send(command, position);
    if ('refused' in sent) {
      const outcome = this.#refuse(command, sent.refused, sent.detail);
      await this.#settle(command, outcome, undefined, undefined);
      return outcome;
    }
    const reported = sent.reported;
    this.#onProgress?.({ idempotencyKey: command.idempotencyKey, stage: 'reconciling', reported });

    // ONE SEND HAS HAPPENED. From here every path reconciles and none re-sends.
    const observation = await this.#observe(command, field, before);
    const outcome = this.#judge(command, reported, field, before, requested, observation);
    await this.#settle(command, outcome, reported, observation.after);
    return outcome;
  }

  /**
   * Send it. Once.
   *
   * A thrown error is classified into "certainly never sent" — which refuses — and
   * everything else, which is recorded as `threw` and then RECONCILED LIKE ANY
   * OTHER SEND. That fallback is the important half: an error after the collateral
   * was credited must not stop us looking at the margin, because the margin is the
   * only thing that knows.
   */
  async #send(
    command: ActionCommand,
    position: ReconcilablePosition,
  ): Promise<
    | { readonly reported: ReportedStatus }
    | { readonly refused: RefusalCode; readonly detail: string }
  > {
    const positionId = command.positionId as number;
    const base = {
      idempotencyKey: command.idempotencyKey,
      symbol: command.symbol,
      ...(this.#venueTimeoutMs === undefined ? {} : { timeoutMs: this.#venueTimeoutMs }),
    };

    try {
      let result: ActionResult;
      switch (command.kind) {
        case 'add-margin':
          result = await this.#venue.addMargin({
            ...base,
            positionId,
            amountCNS: command.amountCNS,
          });
          break;
        case 'reduce-position':
          result = await this.#venue.reducePosition({
            ...base,
            positionId,
            // THE POSITION'S SIDE, read off the position we just looked at, not
            // derived from the action. A close of a long is itself a sell, and
            // handing the venue the order's direction doubles the position.
            positionSide: position.side,
            sizeLNS: command.sizeLNS,
          });
          break;
        case 'close-position':
          result = await this.#venue.closePosition({
            ...base,
            positionId,
            positionSide: position.side,
            // The whole of it, as the position reports it right now.
            sizeLNS: position.sizeLNS,
          });
          break;
      }
      return {
        reported: {
          status: result.status,
          reason: result.reason,
          venueRef: result.venueRef,
        },
      };
    } catch (error) {
      if (error instanceof NotImplementedError) {
        return {
          refused: 'not-implemented',
          detail:
            `${command.kind} is not built for this venue yet, so nothing was sent. ` +
            `Its wire frame has not been measured against a real round trip — the same rule ` +
            `that produced the position shape: measure, then build.`,
        };
      }
      if (error instanceof ForwardingNotAllowedError) {
        return {
          refused: 'not-actionable',
          detail: `${message(error)} Nothing was sent.`,
        };
      }
      if (error instanceof ActionTimeoutError) {
        // NOT A FAILURE. The action may be resting, filling, or already applied.
        this.#logger.warn(
          `${command.idempotencyKey}: no outcome from the venue after ${error.waitedMs}ms ` +
            `(${error.stage}). Reconciling against the position; NOT re-sending.`,
        );
        return {
          reported: {
            status: 'timeout',
            reason: message(error),
            venueRef: error.venueRef,
          },
        };
      }
      // Unclassified. We do not know whether it was sent, so we look at the
      // position — which answers the only question that matters.
      this.#logger.warn(
        `${command.idempotencyKey}: the venue call threw (${message(error)}). Reconciling ` +
          `against the position; NOT re-sending.`,
      );
      return {
        reported: { status: 'threw', reason: message(error), venueRef: undefined },
      };
    }
  }

  /**
   * Watch the position until the field moves, or until we have watched long
   * enough to say it did not.
   *
   * Event-driven off the reader's own change notification rather than a poll, so
   * a top-up that lands in one block is reconciled in one block. The timer is the
   * floor on how long "it did not move" takes to establish, not a deadline on the
   * action.
   */
  #observe(command: ActionCommand, field: WatchedField, before: bigint): Promise<Observation> {
    const startedAtMs = this.#now();
    return new Promise<Observation>((resolve) => {
      let done = false;
      let unsubscribe: Unsubscribe | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (observation: Omit<Observation, 'waitedMs'>): void => {
        if (done) return;
        done = true;
        unsubscribe?.();
        if (timer !== undefined) clearTimeout(timer);
        resolve({ ...observation, waitedMs: this.#now() - startedAtMs });
      };

      const look = (): void => {
        const status = this.#positions.status();
        if (!positionsAreUsable(status)) {
          // The set stopped being believable mid-action. Anything we read now is
          // last-known rather than current, and a verdict from it would be
          // confident and possibly wrong.
          finish({
            after: undefined,
            untrustedReason:
              status.reason ??
              `the position set became ${status.state} while the action was in flight`,
            changed: false,
          });
          return;
        }
        const position = this.#positions.read(command.marketId);
        if (position === undefined) {
          finish({ after: undefined, untrustedReason: undefined, changed: true });
          return;
        }
        const after = field === 'margin' ? position.marginCNS : position.sizeLNS;
        if (after !== before) {
          finish({ after, untrustedReason: undefined, changed: true });
        }
      };

      unsubscribe = this.#positions.onChange(look);
      timer = this.#setTimeout(() => {
        const status = this.#positions.status();
        if (!positionsAreUsable(status)) {
          finish({
            after: undefined,
            untrustedReason:
              status.reason ?? `the position set is ${status.state} after the settle wait`,
            changed: false,
          });
          return;
        }
        const position = this.#positions.read(command.marketId);
        const after =
          position === undefined
            ? undefined
            : field === 'margin'
              ? position.marginCNS
              : position.sizeLNS;
        finish({ after, untrustedReason: undefined, changed: after !== before });
      }, this.#settleTimeoutMs);

      // The change may already be there: a position update can arrive between the
      // venue resolving and this subscription going on.
      look();
    });
  }

  /** Turn one observation into the outcome, via the pure reconcilers. */
  #judge(
    command: ActionCommand,
    reported: ReportedStatus,
    field: WatchedField,
    before: bigint,
    requested: bigint,
    observation: Observation,
  ): ActionOutcome {
    const at = this.#now();

    if (observation.untrustedReason !== undefined) {
      return {
        kind: 'unknown',
        command,
        at,
        reported,
        reconciliation: undefined,
        detail:
          `${command.kind} on ${command.symbol} was sent and I cannot say what it did: ` +
          `${observation.untrustedReason}. The venue reported ${describe(reported)}.`,
        nextStep:
          `Read the position directly — its ${field} is the only thing that says whether this ` +
          `landed. Do NOT send this action again until you have: the venue may have applied it ` +
          `already.`,
      };
    }

    const reconciliation = this.#reconcile(command, before, requested, observation, reported);

    switch (reconciliation.verdict) {
      case 'applied':
        return {
          kind: 'applied',
          command,
          at,
          reported,
          reconciliation,
          detail: appliedDetail(command, reconciliation, reported),
        };
      case 'not-applied':
        return {
          kind: 'not-applied',
          command,
          at,
          reported,
          reconciliation,
          detail:
            `${command.kind} on ${command.symbol} did not land: ${reconciliation.detail} ` +
            `The venue reported ${describe(reported)}.`,
        };
      case 'unknown':
        return {
          kind: 'unknown',
          command,
          at,
          reported,
          reconciliation,
          detail:
            `${command.kind} on ${command.symbol} cannot be resolved: ${reconciliation.detail} ` +
            `The venue reported ${describe(reported)}.`,
          nextStep:
            `Read the position and its history before anything else. Do NOT send this action ` +
            `again on the strength of this outcome.`,
        };
    }
  }

  #reconcile(
    command: ActionCommand,
    before: bigint,
    requested: bigint,
    observation: Observation,
    reported: ReportedStatus,
  ): Reconciliation {
    switch (command.kind) {
      case 'add-margin':
        return reconcileAddMargin({
          requestedCNS: requested,
          beforeCNS: before,
          afterCNS: observation.after,
        });
      case 'reduce-position':
        return reconcileReduce({
          requestedLNS: requested,
          beforeLNS: before,
          afterLNS: observation.after,
        });
      case 'close-position':
        return reconcileClose({
          beforeLNS: before,
          afterLNS: observation.after,
          // The ONE narrow use of the venue's word in this layer: for a close,
          // a confirmed fill plus a position that has left the set is two
          // independent pieces of evidence agreeing. Absence alone is not
          // enough — a liquidation looks identical.
          venueConfirmed: reported.status === 'confirmed',
        });
    }
  }

  #refuse(command: ActionCommand, code: RefusalCode, detail: string): ActionOutcome {
    const outcome: ActionOutcome = { kind: 'refused', command, at: this.#now(), code, detail };
    this.#logger.info(`${command.idempotencyKey}: refused (${code}) — ${detail}`);
    return outcome;
  }

  async #settle(
    command: ActionCommand,
    outcome: ActionOutcome,
    reported: ReportedStatus | undefined,
    after: bigint | undefined,
  ): Promise<void> {
    try {
      await this.#log.settle({
        idempotencyKey: command.idempotencyKey,
        outcome: outcome.kind,
        reportedStatus: reported?.status,
        reportedReason: reported?.reason,
        venueRef: reported?.venueRef,
        after,
        detail: outcome.detail,
        settledAtMs: this.#now(),
      });
    } catch (error) {
      // A LOG FAILURE MUST NOT CHANGE THE REPORTED OUTCOME. The action already
      // happened, or already did not; losing the row is bad and inventing a
      // different answer because of it would be worse. The open row stays
      // unsettled, which is exactly the signal a human should go looking at.
      this.#logger.warn(
        `${command.idempotencyKey}: could not record the settlement (${message(error)}). The ` +
          `outcome stands as ${outcome.kind}; its action_log row is left open.`,
      );
    }
  }
}

function watchedField(command: ActionCommand): WatchedField {
  return command.kind === 'add-margin' ? 'margin' : 'size';
}

/** What was asked for, in the units of the watched field. */
function requestedAmount(command: ActionCommand, position: ReconcilablePosition): bigint {
  switch (command.kind) {
    case 'add-margin':
      return command.amountCNS;
    case 'reduce-position':
      return command.sizeLNS;
    case 'close-position':
      // A close asks for all of it, so the request IS the current size.
      return position.sizeLNS;
  }
}

function describe(reported: ReportedStatus): string {
  return reported.reason === undefined
    ? reported.status
    : `${reported.status} (${reported.reason})`;
}

/**
 * The applied sentence, which for a top-up has to say the venue was wrong.
 *
 * Said out loud rather than quietly dropped, because a reader who later finds
 * `st: 7 Failed` in the log or the explorer needs to know it was seen and
 * accounted for — otherwise they conclude the tool got lucky.
 */
function appliedDetail(
  command: ActionCommand,
  reconciliation: Reconciliation,
  reported: ReportedStatus,
): string {
  const head = `${command.kind} on ${command.symbol} LANDED: ${reconciliation.detail}.`;
  if (reported.status === 'rejected') {
    return (
      `${head} The venue reported it as rejected — ${describe(reported)} — which for this order ` +
      `type is the normal report for a top-up that worked. The position is the evidence; ` +
      `nothing was re-sent.`
    );
  }
  if (reported.status === 'timeout') {
    return (
      `${head} The venue never reported an outcome — ${describe(reported)} — so this was ` +
      `resolved by looking at the position. Nothing was re-sent.`
    );
  }
  if (reported.status === 'threw') {
    return (
      `${head} The venue call itself failed — ${describe(reported)} — but the position moved by ` +
      `exactly what was asked. Nothing was re-sent.`
    );
  }
  return `${head} The venue reported ${describe(reported)}.`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
