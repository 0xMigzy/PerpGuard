/**
 * The bot's {@link ActionExecutor}, backed by the real actions layer.
 *
 * This is a translation and nothing more. It holds no policy: the idempotency
 * key, the `action_log` row, the one-in-flight lock, the reconciliation and the
 * refusal to retry all live in `apps/backend/src/actions`, where the position
 * reader is. What happens here is turning an {@link AlertAction} into an
 * `ActionCommand` and an `ActionOutcome` back into words a trader reads.
 *
 * TWO RULES SURVIVE THE TRANSLATION, and they are the reason this file is worth
 * reading rather than skimming:
 *
 *   A TOP-UP THAT THE VENUE CALLED FAILED IS REPORTED AS DONE. `applied` is
 *   `applied`, and the message says the margin is in. Telling someone their
 *   rescue failed when it worked is how they double it by hand — which is exactly
 *   what happened during the investigation, at the cost of a real position's
 *   collateral being committed twice.
 *
 *   AN UNKNOWN OUTCOME NEVER INVITES A RETRY. It carries the next step from the
 *   actions layer verbatim, and that step is always "go and look", never "try
 *   again". A user who is told "something went wrong" and nothing else will retry
 *   by hand, and for this action that is the dangerous move.
 */
import type { ActingMarket, ActionAvailability } from '@perpguard/shared';
import type { ActionCommand, ActionOutcome } from '@perpguard/backend/actions';
import type { ActionExecutor, ExecuteRequest, ExecutionOutcome } from './actions.ts';

/** What this adapter needs from the actions layer. */
export interface CommandRunner {
  execute(command: ActionCommand): Promise<ActionOutcome>;
}

export interface VenueActionExecutorOptions {
  readonly runner: CommandRunner;
  /** Asked of the ACTING venue, which is not the venue positions were read from. */
  readonly availability: (market: ActingMarket) => Promise<ActionAvailability>;
}

export class VenueActionExecutor implements ActionExecutor {
  readonly #runner: CommandRunner;
  readonly #availability: (market: ActingMarket) => Promise<ActionAvailability>;

  constructor(options: VenueActionExecutorOptions) {
    this.#runner = options.runner;
    this.#availability = options.availability;
  }

  async availability(market: ActingMarket): Promise<ActionAvailability> {
    return this.#availability(market);
  }

  async execute(request: ExecuteRequest): Promise<ExecutionOutcome> {
    const command = toCommand(request);
    if (command === undefined) {
      return {
        kind: 'not-implemented',
        detail:
          `That ${request.action.type} carries no size to send, so nothing was sent.`,
      };
    }
    return describeExecutionOutcome(await this.#runner.execute(command));
  }
}

/**
 * An alert action -> a command.
 *
 * `amountCNS` PASSES THROUGH UNTOUCHED. It is the exact figure the user read on
 * the confirmation screen, and the promise this product makes is that the button
 * sends what the message showed. Re-deriving it here — from the label, from the
 * position, from anything — would break that promise silently.
 *
 * Returns `undefined` for an action type this adapter cannot express, rather than
 * inventing a command for it.
 */
function toCommand(request: ExecuteRequest): ActionCommand | undefined {
  const { action } = request;
  const base = {
    idempotencyKey: request.idempotencyKey,
    userId: request.userId,
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    marketId: action.marketId,
    symbol: action.symbol,
    positionId: action.positionId,
  };
  switch (action.type) {
    case 'add-margin':
      return { kind: 'add-margin', ...base, amountCNS: action.amountCNS };
    case 'reduce-position':
      // Lots pass through untouched, exactly as the confirmation quoted them.
      if (action.sizeLNS === undefined || action.sizeLNS <= 0n) return undefined;
      return { kind: 'reduce-position', ...base, sizeLNS: action.sizeLNS };
    case 'close-position':
      return { kind: 'close-position', ...base };
  }
}

/**
 * An outcome -> what the user is told.
 *
 * The `applied` sentence does NOT mention the venue's reported failure. That
 * detail is in the `action_log` row and in the server's log line, where somebody
 * debugging needs it; a trader reading "your margin is in, although the venue
 * said it failed" learns only that the tool is unsure, and the tool is not
 * unsure — it looked at the position.
 */
/**
 * EXPORTED so the web's Protect page tells a trader the same sentence the bot
 * does for the same outcome. Two front doors, one set of words.
 */
export function describeExecutionOutcome(outcome: ActionOutcome): ExecutionOutcome {
  switch (outcome.kind) {
    case 'applied':
      return {
        kind: 'applied',
        detail: appliedText(outcome),
        ...(outcome.reported.status === 'rejected' ? { venueRejected: true } : {}),
      };
    case 'not-applied':
      // SAYS WHY SENDING AGAIN IS SAFE, rather than leaving the user to wonder.
      // The check is the whole justification: nothing landed, so nothing can land
      // twice. A user who is not told that will either not retry a rescue that
      // needs retrying, or retry something they should not.
      return {
        kind: 'not-applied',
        detail:
          `Nothing was added. I checked the position afterwards and its margin is unchanged, ` +
          `so no collateral left your balance and the request did not reach the exchange. ` +
          `Sending it again is safe — I verified nothing landed, so it cannot go through twice.`,
      };
    case 'unknown':
      return {
        kind: 'unknown',
        detail:
          `I sent it and I cannot tell you yet what it did. ${outcome.detail}`,
        // Verbatim from the actions layer. It never says "retry".
        nextStep: outcome.nextStep,
      };
    case 'refused':
      return { kind: 'refused', detail: refusedText(outcome) };
  }
}

function appliedText(outcome: Extract<ActionOutcome, { kind: 'applied' }>): string {
  const reconciliation = outcome.reconciliation;
  if (outcome.command.kind === 'close-position') {
    return 'Done — the position is closed. I checked afterwards and it is gone.';
  }
  if (outcome.command.kind === 'reduce-position') {
    return 'Done — the position is smaller. I checked its size afterwards and the reduction is there.';
  }
  if (reconciliation.field !== 'margin' || reconciliation.after === undefined) {
    return 'Done. I checked the position afterwards and the change is there.';
  }
  return (
    `Done — the margin is in. I checked the position afterwards: it went from ` +
    `${reconciliation.before} to ${reconciliation.after} AUSD micros, which is exactly the ` +
    `${reconciliation.requested} that was sent. My positions shows the new buffer and ` +
    `closing price.`
  );
}

/**
 * A refusal, in the user's terms.
 *
 * Every branch says what would make it possible, because a refusal a user cannot
 * act on is indistinguishable from a broken bot.
 */
function refusedText(outcome: Extract<ActionOutcome, { kind: 'refused' }>): string {
  switch (outcome.code) {
    case 'already-in-flight':
      return (
        `There is already an action in flight on this position and it has not settled. I am ` +
        `refusing rather than queueing this one: a second top-up sent behind the first is how ` +
        `the same amount lands twice. Wait a moment, then open My positions.`
      );
    case 'feed-down':
      return (
        `I will not act while the price feed is down. Every price I hold is frozen at whatever ` +
        `it was when the connection died, so the amount you confirmed may no longer be the ` +
        `right one. Nothing was sent. My positions shows when it is back.`
      );
    case 'positions-untrusted':
      return (
        `I have lost track of your positions, so I cannot check this one before or after acting. ` +
        `Nothing was sent. My positions has the detail.`
      );
    case 'no-position':
      return `I no longer hold a position on this market, so there was nothing to add margin to. Nothing was sent.`;
    case 'position-exists':
      return `Not sent: ${outcome.detail}`;
    case 'no-position-id':
      return (
        `I do not have this position's venue id, so I cannot address the top-up to it. Nothing ` +
        `was sent. Open My positions — a fresh snapshot usually carries it.`
      );
    case 'not-actionable':
      return `Not sent: ${outcome.detail}`;
    case 'not-implemented':
      return `Not sent: ${outcome.detail}`;
    case 'not-recorded':
      return `Not sent: ${outcome.detail}`;
    case 'wrong-account':
      return `Not sent: ${outcome.detail}`;
    case 'invalid-command':
      return `Not sent: ${outcome.detail}`;
    case 'automation-stopped':
      return `Not sent: ${outcome.detail}`;
  }
}
