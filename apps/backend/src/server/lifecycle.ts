/**
 * Two things that have to happen in the right order, and a place to test them.
 *
 * THE STARTUP GATE. Nothing may be assessed until BOTH the first position
 * snapshot has arrived AND the price feed is connected. The second half is the
 * one that bites: if sign-in completes while the market feed is still on its
 * first connect, the loop assesses every position as blind and the alerts engine
 * fires a FEED_DOWN for each — a burst of "the price feed is down" seconds after
 * boot, about a feed that was merely still starting. The first thing a new user
 * would see is a false alarm, which is how an alert stream loses its credibility
 * on day one.
 *
 * THE SHUTDOWN SEQUENCE. Ordered, deadline-bounded, idempotent, and it does not
 * abandon the remaining steps when one fails. A half-sent DANGER alert on
 * restart is worse than a late one, so the drain step comes after everything
 * that could produce a new alert has stopped and before anything it needs is
 * closed.
 *
 * Both are pure enough to test: every clock and every sleep is injected.
 */

export interface WaitUntilReadyOptions {
  /** Asked repeatedly. Must be synchronous — a readiness check that awaits can hang. */
  readonly isReady: () => boolean;
  /** Give up after this long and start anyway. Never exit. */
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  /** Injected so tests do not wait out the poll. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ReadinessOutcome {
  readonly ready: boolean;
  readonly waitedMs: number;
  /** How many times the condition was asked. */
  readonly polls: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wait for the gate, and GIVE UP RATHER THAN BLOCK.
 *
 * A timeout is not a failure to be thrown: if the trading socket never signs in,
 * the position set stays empty, the loop has nothing to assess and therefore
 * emits nothing, so starting anyway is safe and keeps the health endpoint and
 * the price feed working. Refusing to start would take the one thing that still
 * works — the ability to say what is wrong — down with the thing that does not.
 */
export async function waitUntilReady(options: WaitUntilReadyOptions): Promise<ReadinessOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 100;
  const startedAtMs = now();

  let polls = 0;
  for (;;) {
    polls += 1;
    if (options.isReady()) {
      return { ready: true, waitedMs: now() - startedAtMs, polls };
    }
    const waitedMs = now() - startedAtMs;
    if (waitedMs >= options.timeoutMs) {
      return { ready: false, waitedMs, polls };
    }
    await sleep(Math.min(pollMs, options.timeoutMs - waitedMs));
  }
}

export interface ShutdownStep {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface ShutdownStepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  /** Present when the step threw or timed out. Safe to log. */
  readonly error?: string;
}

export interface ShutdownOptions {
  /** Total budget for the whole sequence. A wedged socket must not hold us open. */
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly onStep?: (result: ShutdownStepResult) => void;
}

const DEFAULT_DEADLINE_MS = 10_000;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Run the registered steps in order, once.
 *
 * A FAILING STEP DOES NOT STOP THE REST. Shutdown is a sequence of unrelated
 * closes, and a socket that throws on close is no reason to skip draining the
 * alert queue behind it — that is precisely the step whose omission costs a
 * user their warning.
 */
export class ShutdownSequence {
  readonly #steps: ShutdownStep[] = [];
  readonly #deadlineMs: number;
  readonly #now: () => number;
  readonly #onStep: ((result: ShutdownStepResult) => void) | undefined;
  #running: Promise<readonly ShutdownStepResult[]> | undefined;

  constructor(options: ShutdownOptions = {}) {
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.#now = options.now ?? Date.now;
    this.#onStep = options.onStep;
  }

  /** Steps run in the order they were added. */
  add(name: string, run: () => void | Promise<void>): this {
    this.#steps.push({ name, run });
    return this;
  }

  get stepNames(): readonly string[] {
    return this.#steps.map((step) => step.name);
  }

  /**
   * Run once. A second SIGTERM while shutting down joins the first run rather
   * than starting a second — closing the same socket twice, concurrently, is
   * how a clean shutdown turns into a stack trace on the way out.
   */
  async run(): Promise<readonly ShutdownStepResult[]> {
    this.#running ??= this.#runOnce();
    return this.#running;
  }

  get started(): boolean {
    return this.#running !== undefined;
  }

  async #runOnce(): Promise<readonly ShutdownStepResult[]> {
    const startedAtMs = this.#now();
    const results: ShutdownStepResult[] = [];

    for (const step of this.#steps) {
      const stepStartedAtMs = this.#now();
      const remainingMs = this.#deadlineMs - (stepStartedAtMs - startedAtMs);
      let result: ShutdownStepResult;

      if (remainingMs <= 0) {
        result = {
          name: step.name,
          ok: false,
          ms: 0,
          error: `skipped: the ${this.#deadlineMs}ms shutdown budget was already spent`,
        };
      } else {
        try {
          await withTimeout(step.run(), remainingMs, step.name);
          result = { name: step.name, ok: true, ms: this.#now() - stepStartedAtMs };
        } catch (error) {
          result = {
            name: step.name,
            ok: false,
            ms: this.#now() - stepStartedAtMs,
            error: describe(error),
          };
        }
      }

      results.push(result);
      this.#onStep?.(result);
    }
    return results;
  }
}

/** Bound one step, so a socket that never closes cannot hold the process open. */
async function withTimeout(
  work: void | Promise<void>,
  ms: number,
  name: string,
): Promise<void> {
  if (!(work instanceof Promise)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
