/**
 * Firing the kill switch.
 *
 * The ordering comes from `killSwitchPlan` in the risk engine — nearest to
 * liquidation first, because that is the position that may not survive long
 * enough to be second. This file does the firing and the reporting, and gets two
 * things right that a naive loop would not:
 *
 *   CLOSES GO OUT ONE AT A TIME. Not for politeness: a parallel fire would race
 *   the in-flight registry, and on Perpl it would race the account's `rq`
 *   counter, which must be strictly increasing per account. Sequential is also
 *   the only way the ordering means anything — firing all of them at once makes
 *   "most urgent first" a comment rather than a behaviour.
 *
 *   A FAILURE DOES NOT STOP THE SEQUENCE. The next-most-urgent position still
 *   needs closing, and abandoning the rest because one refused would turn one bad
 *   outcome into several. Every position gets its own attempt and its own
 *   reported outcome.
 *
 * A PARTIAL KILL SWITCH MUST SAY SO, position by position. "Kill switch fired"
 * over a book where two of five closed is the single most dangerous sentence this
 * product could produce: the trader stops watching. So the result carries every
 * outcome, and {@link describeKillSwitch} leads with what did NOT close.
 */
import { killSwitchPlan, type KillSwitchPlan, type MarketRiskConfig, type RiskPosition } from '@perpguard/shared';
import type { ActionCommand, ActionOutcome, ActionOutcomeKind } from './types.ts';

/** What fires one close. Satisfied by `ActionsExecutor`. */
export interface CommandRunner {
  execute(command: ActionCommand): Promise<ActionOutcome>;
}

export interface KillSwitchLineResult {
  readonly marketId: number;
  readonly symbol: string;
  /** Where it sat in the firing order, 1-based, so a report can be read back. */
  readonly order: number;
  /** Signed. Negative means the position was already past its liquidation price. */
  readonly liqBufferPct: number | undefined;
  readonly outcome: ActionOutcome;
}

export interface KillSwitchResult {
  readonly plan: KillSwitchPlan;
  readonly lines: readonly KillSwitchLineResult[];
  /** Positions whose close is evidenced as having flattened them. */
  readonly closed: readonly KillSwitchLineResult[];
  /** Positions still open, as far as we can tell. Refused and not-applied. */
  readonly stillOpen: readonly KillSwitchLineResult[];
  /** Positions whose state we could not establish. The ones needing human eyes. */
  readonly unresolved: readonly KillSwitchLineResult[];
  /**
   * True only when every position in the plan is evidenced as closed.
   *
   * Deliberately not "no errors": an `unknown` is not a success, and a kill
   * switch that called itself complete with one position unaccounted for would be
   * lying in the direction that gets someone liquidated.
   */
  readonly complete: boolean;
}

export interface FireKillSwitchOptions {
  readonly runner: CommandRunner;
  readonly userId: string;
  readonly positions: readonly RiskPosition[];
  /** Keyed by market id. One network's marks, for one network's positions. */
  readonly markPrices: ReadonlyMap<number, bigint>;
  readonly configs: ReadonlyMap<number, MarketRiskConfig>;
  /** Venue position ids by market id, for `lp`. A missing one refuses that close. */
  readonly positionIds: ReadonlyMap<number, number>;
  /**
   * Builds each close's idempotency key.
   *
   * Injected so it is deterministic under test, and so every close in one firing
   * can share a run id — which is what lets a human pull the whole sequence out
   * of `action_log` with one query.
   */
  readonly keyFor: (marketId: number, order: number) => string;
  readonly logger?: { info(message: string): void; warn(message: string): void };
}

/**
 * Close everything, most urgent first.
 *
 * Returns rather than throws, always. A kill switch that threw partway would
 * leave the caller holding an exception and no idea which positions had closed,
 * which is the one outcome worse than a partial close.
 */
export async function fireKillSwitch(options: FireKillSwitchOptions): Promise<KillSwitchResult> {
  const plan = killSwitchPlan(options.positions, options.markPrices, options.configs);
  const lines: KillSwitchLineResult[] = [];

  for (const [index, line] of plan.perPosition.entries()) {
    const order = index + 1;
    const marketId = line.position.marketId;
    const command: ActionCommand = {
      kind: 'close-position',
      idempotencyKey: options.keyFor(marketId, order),
      userId: options.userId,
      marketId,
      symbol: line.position.symbol,
      positionId: options.positionIds.get(marketId),
    };

    options.logger?.info(
      `kill switch ${order}/${plan.perPosition.length}: closing ${line.position.symbol} ` +
        `(market ${marketId}, buffer ${describeBuffer(line.liqBufferPct)})`,
    );

    // Sequential, and every outcome is kept. The executor already returns rather
    // than throwing for everything it can classify; this guard is for the rest,
    // because one unexpected throw must not cost the remaining positions their
    // close.
    let outcome: ActionOutcome;
    try {
      outcome = await options.runner.execute(command);
    } catch (error) {
      outcome = {
        kind: 'unknown',
        command,
        at: Date.now(),
        reported: { status: 'threw', reason: message(error), venueRef: undefined },
        reconciliation: undefined,
        detail:
          `closing ${line.position.symbol} threw before reporting an outcome: ${message(error)}. ` +
          `Whether the close was sent is not known.`,
        nextStep:
          `Read this position directly. Do NOT re-fire the kill switch to "finish the job" — ` +
          `that would re-send closes for positions that already closed.`,
      };
      options.logger?.warn(
        `kill switch ${order}/${plan.perPosition.length}: ${line.position.symbol} threw — ` +
          `${message(error)}. Continuing with the remaining positions.`,
      );
    }

    lines.push({
      marketId,
      symbol: line.position.symbol,
      order,
      liqBufferPct: line.liqBufferPct,
      outcome,
    });
  }

  const of = (...kinds: readonly ActionOutcomeKind[]): KillSwitchLineResult[] =>
    lines.filter((line) => kinds.includes(line.outcome.kind));

  const closed = of('applied');
  return {
    plan,
    lines,
    closed,
    stillOpen: of('not-applied', 'refused'),
    unresolved: of('unknown'),
    complete: lines.length > 0 && closed.length === lines.length,
  };
}

/** A signed buffer in words. Negative is never shown as a small percentage. */
function describeBuffer(buffer: number | undefined): string {
  if (buffer === undefined) return 'no size';
  if (buffer < 0) return 'past liquidation';
  return `${(buffer * 100).toFixed(1)}%`;
}

/**
 * The report a human reads.
 *
 * WHAT DID NOT CLOSE COMES FIRST. A reader who stops after one line must stop on
 * the positions still carrying risk, not on the reassuring count — and the
 * reassuring count is exactly what they would remember if it led.
 */
export function describeKillSwitch(result: KillSwitchResult): string {
  const total = result.lines.length;
  if (total === 0) return 'Kill switch: nothing to close — no open positions.';

  const lines: string[] = [];

  if (result.complete) {
    lines.push(`Kill switch complete: all ${total} position${total === 1 ? '' : 's'} closed.`);
  } else {
    const outstanding = result.stillOpen.length + result.unresolved.length;
    lines.push(
      `Kill switch PARTIAL: ${result.closed.length} of ${total} closed, ${outstanding} not. ` +
        `You still have exposure.`,
    );
    for (const line of [...result.unresolved, ...result.stillOpen]) {
      const label = line.outcome.kind === 'unknown' ? 'UNRESOLVED' : 'still open';
      lines.push(`  ${line.symbol} — ${label}: ${line.outcome.detail}`);
    }
  }

  for (const line of result.closed) {
    lines.push(`  ${line.symbol} — closed: ${line.outcome.detail}`);
  }

  if (result.unresolved.length > 0) {
    lines.push(
      'Do not fire the kill switch again to finish: that would re-send closes for the ' +
        'positions that already closed. Read the unresolved ones first.',
    );
  }
  return lines.join('\n');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
