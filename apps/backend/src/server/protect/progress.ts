/**
 * Where an action has got to, for a page that polls.
 *
 * Fed by the executor's `onProgress` hook and finished by the route that
 * started the action. Stages are what HAPPENED, never what is expected: a
 * page shows "accepted by the forwarder" only once the venue actually replied,
 * and the outcome only once the position has been read.
 */
import type { ActionProgress } from '../../actions/executor.ts';
import type { PrepareRequest, ProtectKillSwitchOutcome, ProtectOutcome, ProtectProgress, ProtectReported } from './types.ts';

const KEEP_MS = 60 * 60_000;

export class ActionProgressTracker {
  readonly #entries = new Map<string, ProtectProgress>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  start(idempotencyKey: string, kind: PrepareRequest['kind'], symbol: string | undefined): ProtectProgress {
    this.#sweep();
    const entry: ProtectProgress = { idempotencyKey, kind, symbol, stage: 'queued', startedAtMs: this.#now(), reported: undefined, outcome: undefined };
    this.#entries.set(idempotencyKey, entry);
    return entry;
  }

  /** The executor's hook. Unknown keys (the bot's own actions) are ignored. */
  record(progress: ActionProgress): void {
    const entry = this.#entries.get(progress.idempotencyKey);
    if (entry === undefined || entry.stage === 'settled') return;
    if (progress.stage === 'sending') {
      this.#entries.set(progress.idempotencyKey, { ...entry, stage: 'sending' });
    } else {
      const reported: ProtectReported = { status: progress.reported.status, reason: progress.reported.reason, venueRef: progress.reported.venueRef };
      this.#entries.set(progress.idempotencyKey, { ...entry, stage: 'reconciling', reported });
    }
  }

  finish(idempotencyKey: string, outcome: ProtectOutcome | ProtectKillSwitchOutcome): void {
    const entry = this.#entries.get(idempotencyKey);
    if (entry === undefined) return;
    this.#entries.set(idempotencyKey, {
      ...entry,
      stage: 'settled',
      reported: outcome.kind === 'kill-switch' ? entry.reported : (outcome.reported ?? entry.reported),
      outcome,
    });
  }

  get(idempotencyKey: string): ProtectProgress | undefined {
    return this.#entries.get(idempotencyKey);
  }

  #sweep(): void {
    const cutoff = this.#now() - KEEP_MS;
    for (const [key, e] of this.#entries) if (e.startedAtMs <= cutoff) this.#entries.delete(key);
  }
}
