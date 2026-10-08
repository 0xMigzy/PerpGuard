/**
 * 🚪 CLOSE EVERYTHING (owner, 7 Oct 2026). Closes every open position on one
 * account, and says exactly what happened to each.
 *
 *   1. PerpGuard STOPS FIRST (the kill switch), so nothing tops up or re-arms a
 *      position that is being exited.
 *   2. ONE RUN IN FLIGHT PER ACCOUNT, and every request id runs ONCE: a second
 *      tap, a replayed confirmation or a retry of the same request sends no
 *      second set of orders. Each close carries `closeall:<acct>:<request>:<pid>`.
 *   3. Closes go out ONE AT A TIME through the account's own executor (one in
 *      flight per position, the feed gate, forwarding pre-flight, the
 *      `action_log` row). NEVER RE-SENT.
 *   4. THE OUTCOME IS READ FROM THE POSITION LIST AFTERWARDS (`verify.ts`):
 *      closed, partly closed, still open with why, or not seen.
 *   5. Everything already flat: says so, sends nothing.
 *   6. Logged: what was requested, each receipt, each verified outcome
 *      (`close_all_runs`, beside each close's own `action_log` row).
 */
import type { ActionCommand, ActionOutcome } from '../actions/types.ts';
import type { KillSwitch, StopReport } from '../rescue/killSwitch.ts';
import { verifyCloses, type OpenPosition, type Verified } from './verify.ts';
import type { CloseAllRunStore } from './store.ts';

/** What a run needs from one account's session. */
export interface CloseAllAccount {
  /** Every open position from a FULLY LOADED list, or undefined when it is not loaded. */
  openPositions(): readonly OpenPosition[] | undefined;
  execute(command: ActionCommand): Promise<ActionOutcome>;
  /** What a just-closed position filled at, from its closing row. Informative only. */
  exitPrice(position: OpenPosition): number | undefined;
}

export type CloseAllReport =
  /** Nothing was sent: why, and that PerpGuard is stopped. */
  | { readonly kind: 'nothing-sent'; readonly why: 'already-flat' | 'cannot-see' | 'no-session'; readonly stop: StopReport | undefined }
  /** Another run on this account is still going. Nothing new was sent. */
  | { readonly kind: 'already-running' }
  | { readonly kind: 'ran'; readonly verified: Verified; readonly stop: StopReport | undefined; readonly replayed: boolean; readonly automationOff?: boolean };

/**
 * What runs before the closes. Close everything and its retries STOP ALL AUTOMATION (the kill
 * switch). 🚪 Close position turns off automation for THAT position only (owner, 8 Oct 2026):
 * closing one position is not a reason to stop rescuing the others.
 */
type Scope = { readonly kind: 'all' } | { readonly kind: 'retry'; readonly marketId: number } | { readonly kind: 'position'; readonly marketId: number };

export interface CloseEverythingOptions {
  readonly killSwitch: Pick<KillSwitch, 'stop'>;
  /** 🚪 Close position: turn off automation for this one position. True when something was on and is now off. */
  readonly stopPositionAutomation?: (accountId: number, marketId: number, by: string) => Promise<boolean>;
  readonly account: (accountId: number) => CloseAllAccount | undefined;
  readonly store: CloseAllRunStore;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the position list to show the closes. */
  readonly settleMs?: number;
}

export class CloseEverything {
  readonly #o: CloseEverythingOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #inFlight = new Set<number>();
  /** Finished runs by `account:request`, so a repeated request answers without sending. */
  readonly #done = new Map<string, CloseAllReport>();

  constructor(options: CloseEverythingOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  inFlightOn(accountId: number): boolean {
    return this.#inFlight.has(accountId);
  }

  /** Every open position, for the confirmation screen. Undefined when the list cannot be seen. */
  preview(accountId: number): readonly OpenPosition[] | undefined {
    return this.#o.account(accountId)?.openPositions();
  }

  /** Close every open position. `requestId` is minted when the confirmation was shown, and runs once. */
  async closeAll(accountId: number, requestId: string, by: string): Promise<CloseAllReport> {
    return this.#run(accountId, requestId, by, { kind: 'all' });
  }

  /** Close what remains of ONE position after a Close everything, as its own request. Stops all automation, as the run it retries did. */
  async closeOne(accountId: number, marketId: number, requestId: string, by: string): Promise<CloseAllReport> {
    return this.#run(accountId, requestId, by, { kind: 'retry', marketId });
  }

  /**
   * 🚪 CLOSE POSITION, from the position's own screen: the same once-only, one-in-flight, verified
   * close, preceded by turning off automation for THIS position only.
   */
  async closePosition(accountId: number, marketId: number, requestId: string, by: string): Promise<CloseAllReport> {
    return this.#run(accountId, requestId, by, { kind: 'position', marketId });
  }

  async #run(accountId: number, requestId: string, by: string, scope: Scope): Promise<CloseAllReport> {
    const key = `${accountId}:${requestId}`;
    const earlier = this.#done.get(key);
    if (earlier !== undefined) {
      this.#o.log(`close-everything ${key}: asked again; already ran, nothing sent`);
      return earlier.kind === 'ran' ? { ...earlier, replayed: true } : earlier;
    }
    if (this.#inFlight.has(accountId)) {
      this.#o.log(`close-everything ${key}: another run is in flight on account ${accountId}; nothing sent`);
      return { kind: 'already-running' };
    }
    this.#inFlight.add(accountId);
    try {
      const report = await this.#runOnce(accountId, requestId, by, scope);
      this.#done.set(key, report);
      return report;
    } finally {
      this.#inFlight.delete(accountId);
    }
  }

  async #runOnce(accountId: number, requestId: string, by: string, scope: Scope): Promise<CloseAllReport> {
    const { log } = this.#o;
    const startedAtMs = this.#now();
    const onlyMarket = scope.kind === 'all' ? undefined : scope.marketId;
    // 1. STOP FIRST: nothing automated may touch a position being exited. All of it for Close
    //    everything; for one position, only that position's automation.
    let stop: StopReport | undefined;
    let automationOff = false;
    if (scope.kind === 'position') {
      automationOff = (await this.#o.stopPositionAutomation?.(accountId, scope.marketId, by)) ?? false;
      if (automationOff) log(`close-position ${accountId}:${requestId}: automation turned off for market ${scope.marketId} before closing`);
    } else {
      stop = await this.#o.killSwitch.stop(accountId, `${by} (close everything)`);
    }

    const account = this.#o.account(accountId);
    if (account === undefined) {
      log(`close-everything ${accountId}:${requestId}: no session for the account; PerpGuard stopped, nothing sent`);
      await this.#record(accountId, requestId, by, startedAtMs, [], new Map(), { kind: 'nothing-sent', why: 'no-session', stop });
      return { kind: 'nothing-sent', why: 'no-session', stop };
    }
    const all = account.openPositions();
    if (all === undefined) {
      log(`close-everything ${accountId}:${requestId}: the position list is not loaded; PerpGuard stopped, nothing sent`);
      await this.#record(accountId, requestId, by, startedAtMs, [], new Map(), { kind: 'nothing-sent', why: 'cannot-see', stop });
      return { kind: 'nothing-sent', why: 'cannot-see', stop };
    }
    const requested = onlyMarket === undefined ? all : all.filter((p) => p.marketId === onlyMarket);
    if (requested.length === 0) {
      log(`close-everything ${accountId}:${requestId}: everything is already flat; nothing sent`);
      await this.#record(accountId, requestId, by, startedAtMs, [], new Map(), { kind: 'nothing-sent', why: 'already-flat', stop });
      return { kind: 'nothing-sent', why: 'already-flat', stop };
    }

    // 3. ONE AT A TIME, each with its own key, never re-sent.
    log(`close-everything ${accountId}:${requestId}: closing ${requested.map((p) => `${p.symbol} ${p.side} ${p.sizeLNS} lots (pid ${p.positionId})`).join(', ')}`);
    const outcomes = new Map<number, ActionOutcome | undefined>();
    for (const p of requested) {
      let outcome: ActionOutcome | undefined;
      try {
        outcome = await account.execute({
          kind: 'close-position',
          idempotencyKey: `${scope.kind === 'position' ? 'close' : 'closeall'}:${accountId}:${requestId}:${p.positionId}`,
          userId: by,
          accountId,
          marketId: p.marketId,
          symbol: p.symbol,
          positionId: p.positionId,
        });
      } catch (error) {
        log(`close-everything ${accountId}:${requestId}: ${p.symbol} close threw: ${error instanceof Error ? error.message : String(error)}`);
      }
      outcomes.set(p.positionId, outcome);
      log(
        `close-everything ${accountId}:${requestId}: ${p.symbol} receipt ${outcome === undefined ? 'none' : outcome.kind === 'refused' ? `refused (${outcome.code})` : `${outcome.reported.status}${outcome.reported.reason === undefined ? '' : ` (${outcome.reported.reason})`}`}`,
      );
    }

    // 4. THE POSITION LIST DECIDES. Wait for it to show the closes, or for the settle limit.
    const after = await this.#settle(account, requested);
    const verified = verifyCloses(requested, after, outcomes, (p) => account.exitPrice(p));
    for (const r of verified.results) {
      log(`close-everything ${accountId}:${requestId}: ${r.position.symbol} VERIFIED ${r.kind}${r.kind === 'partial' ? ` (${r.remainingLNS} lots remain)` : ''}${r.kind === 'still-open' || r.kind === 'partial' || r.kind === 'not-seen' ? `: ${r.why}` : ''}`);
    }
    const report: CloseAllReport = { kind: 'ran', verified, stop, replayed: false, ...(scope.kind === 'position' ? { automationOff } : {}) };
    await this.#record(accountId, requestId, by, startedAtMs, requested, outcomes, report);
    return report;
  }

  /** Re-reads the list until every requested position has left it or changed size, or the limit passes. */
  async #settle(account: CloseAllAccount, requested: readonly OpenPosition[]): Promise<readonly OpenPosition[] | undefined> {
    const until = this.#now() + (this.#o.settleMs ?? 10_000);
    for (;;) {
      const now = account.openPositions();
      const settled = now !== undefined && requested.every((p) => {
        const x = now.find((y) => y.positionId === p.positionId);
        return x === undefined || x.sizeLNS !== p.sizeLNS;
      });
      if (settled || this.#now() >= until) return now;
      await this.#sleep(250);
    }
  }

  async #record(
    accountId: number,
    requestId: string,
    by: string,
    startedAtMs: number,
    requested: readonly OpenPosition[],
    outcomes: ReadonlyMap<number, ActionOutcome | undefined>,
    report: CloseAllReport,
  ): Promise<void> {
    try {
      await this.#o.store.record({
        accountId,
        requestId,
        by,
        startedAtMs,
        finishedAtMs: this.#now(),
        requested: requested.map((p) => ({ symbol: p.symbol, marketId: p.marketId, positionId: p.positionId, side: p.side, sizeLNS: String(p.sizeLNS) })),
        receipts: [...outcomes].map(([positionId, o]) => ({
          positionId,
          outcome: o?.kind ?? 'none',
          receipt: o === undefined ? undefined : o.kind === 'refused' ? `refused: ${o.code}` : `${o.reported.status}${o.reported.reason === undefined ? '' : ` (${o.reported.reason})`}`,
          venueRef: o !== undefined && o.kind !== 'refused' ? o.reported.venueRef : undefined,
        })),
        verified:
          report.kind === 'ran'
            ? report.verified.results.map((r) => ({ positionId: r.position.positionId, symbol: r.position.symbol, kind: r.kind, ...(r.kind === 'partial' ? { remainingLNS: String(r.remainingLNS) } : {}), ...(r.kind === 'closed' ? { exitPrice: r.exitPrice } : {}), ...('why' in r ? { why: r.why } : {}) }))
            : [{ kind: report.kind, ...('why' in report ? { why: report.why } : {}) }],
      });
    } catch (error) {
      this.#o.log(`close-everything ${accountId}:${requestId}: the run could not be recorded (${error instanceof Error ? error.message : String(error)}); the log lines above are the record`);
    }
  }
}
