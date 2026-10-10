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
import type { MarketScale } from '@perpguard/shared';
import { judgePartial, realisedFromFill, type DecreaseFill, type PartialResult } from './partial.ts';
import { verifyCloses, type OpenPosition, type Verified } from './verify.ts';
import type { CloseAllRunStore } from './store.ts';

/** What a run needs from one account's session. */
export interface CloseAllAccount {
  /** Every open position from a FULLY LOADED list, or undefined when it is not loaded. */
  openPositions(): readonly OpenPosition[] | undefined;
  execute(command: ActionCommand): Promise<ActionOutcome>;
  /** What a just-closed position filled at, from its closing row. Informative only. */
  exitPrice(position: OpenPosition): number | undefined;
  /**
   * What a just-REDUCED position's own row says the reduce filled at, with the entry price and
   * scaling to turn it into a realised figure. Undefined when the row does not carry it.
   */
  reduceFill?(position: OpenPosition): { readonly fill: DecreaseFill; readonly entryPricePNS: bigint; readonly scale: MarketScale } | undefined;
}

/**
 * 🚪 CLOSE PART OF A POSITION (owner, 10 Oct 2026). `result` is read from the position before and
 * after; `realisedCNS` and `feeCNS` are the exchange's own fill, present only when the reduced
 * position's row reported a fill of exactly the size the position shrank by.
 */
export type ReduceReport =
  | { readonly kind: 'nothing-sent'; readonly why: 'already-flat' | 'cannot-see' | 'no-session' | 'changed' | 'too-small' }
  | { readonly kind: 'already-running' }
  | {
      readonly kind: 'ran';
      readonly position: OpenPosition;
      readonly requestedLNS: bigint;
      readonly result: PartialResult;
      /** (exit − entry) × size closed, before the fee. */
      readonly realisedCNS: bigint | undefined;
      readonly feeCNS: bigint | undefined;
      readonly exitPricePNS: bigint | undefined;
      readonly replayed: boolean;
    };

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
  readonly #reduced = new Map<string, ReduceReport>();

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

  /**
   * 🚪 CLOSE PART OF A POSITION: one reduce-only market order for `closeLNS` size units, on the
   * full close's rules. ONCE per request id, one run in flight per account (shared with the
   * closes), NEVER RE-SENT, and judged by the position before and after. Automation is NOT
   * touched: the position stays open, so its Auto top-up stays as it is.
   *
   * `expected` is the position the confirmation showed. If it has since changed size or been
   * replaced, nothing is sent: the percentage was of a position that no longer exists.
   */
  async reducePosition(accountId: number, marketId: number, closeLNS: bigint, expected: { readonly positionId: number; readonly sizeLNS: bigint }, requestId: string, by: string): Promise<ReduceReport> {
    const key = `${accountId}:${requestId}`;
    const earlier = this.#reduced.get(key);
    if (earlier !== undefined) {
      this.#o.log(`close-part ${key}: asked again; already ran, nothing sent`);
      return earlier.kind === 'ran' ? { ...earlier, replayed: true } : earlier;
    }
    if (this.#inFlight.has(accountId)) {
      this.#o.log(`close-part ${key}: another run is in flight on account ${accountId}; nothing sent`);
      return { kind: 'already-running' };
    }
    this.#inFlight.add(accountId);
    try {
      const report = await this.#reduceOnce(accountId, marketId, closeLNS, expected, requestId, by);
      this.#reduced.set(key, report);
      return report;
    } finally {
      this.#inFlight.delete(accountId);
    }
  }

  async #reduceOnce(accountId: number, marketId: number, closeLNS: bigint, expected: { readonly positionId: number; readonly sizeLNS: bigint }, requestId: string, by: string): Promise<ReduceReport> {
    const { log } = this.#o;
    const tag = `close-part ${accountId}:${requestId}`;
    const account = this.#o.account(accountId);
    if (account === undefined) {
      log(`${tag}: no session for the account; nothing sent`);
      return { kind: 'nothing-sent', why: 'no-session' };
    }
    const all = account.openPositions();
    if (all === undefined) {
      log(`${tag}: the position list is not loaded; nothing sent`);
      return { kind: 'nothing-sent', why: 'cannot-see' };
    }
    const p = all.find((x) => x.marketId === marketId);
    if (p === undefined) {
      log(`${tag}: no open position on market ${marketId}; nothing sent`);
      return { kind: 'nothing-sent', why: 'already-flat' };
    }
    if (p.positionId !== expected.positionId || p.sizeLNS !== expected.sizeLNS) {
      log(`${tag}: ${p.symbol} is now pid ${p.positionId} at ${p.sizeLNS} lots, not pid ${expected.positionId} at ${expected.sizeLNS} as confirmed; nothing sent`);
      return { kind: 'nothing-sent', why: 'changed' };
    }
    // One size unit is the exchange's minimum order, and a reduce must leave something open.
    if (closeLNS < 1n || closeLNS >= p.sizeLNS) {
      log(`${tag}: ${closeLNS} of ${p.sizeLNS} lots is not a partial close; nothing sent`);
      return { kind: 'nothing-sent', why: 'too-small' };
    }

    log(`${tag}: reducing ${p.symbol} ${p.side} by ${closeLNS} of ${p.sizeLNS} lots (pid ${p.positionId})`);
    let outcome: ActionOutcome | undefined;
    try {
      outcome = await account.execute({
        kind: 'reduce-position',
        idempotencyKey: `reduce:${accountId}:${requestId}:${p.positionId}`,
        userId: by,
        accountId,
        marketId: p.marketId,
        symbol: p.symbol,
        positionId: p.positionId,
        sizeLNS: closeLNS,
      });
    } catch (error) {
      log(`${tag}: ${p.symbol} reduce threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    const receipt = outcome === undefined ? undefined : outcome.kind === 'refused' ? `refused: ${outcome.code}` : `${outcome.reported.status}${outcome.reported.reason === undefined ? '' : ` (${outcome.reported.reason})`}`;
    log(`${tag}: ${p.symbol} receipt ${receipt ?? 'none'}`);

    // THE POSITION DECIDES. A refusal never went out, so there is nothing to wait for.
    const sent = outcome !== undefined && outcome.kind !== 'refused';
    const after = sent ? await this.#settle(account, [p]) : account.openPositions();
    const now = after?.find((x) => x.positionId === p.positionId);
    const result = judgePartial({ beforeLNS: p.sizeLNS, requestedLNS: closeLNS, after: after === undefined ? undefined : now === undefined ? null : now.sizeLNS, receipt: sent ? receipt : undefined });
    let realisedCNS: bigint | undefined;
    let feeCNS: bigint | undefined;
    let exitPricePNS: bigint | undefined;
    if (result.kind === 'reduced' && now !== undefined) {
      const reported = account.reduceFill?.(now);
      // Only a fill of exactly the size the position shrank by is this reduce's fill.
      if (reported !== undefined && reported.fill.closedLNS === result.closedLNS) {
        realisedCNS = realisedFromFill({ side: p.side, entryPricePNS: reported.entryPricePNS, fill: reported.fill, scale: reported.scale });
        feeCNS = reported.fill.feeCNS;
        exitPricePNS = reported.fill.exitPricePNS;
      }
    }
    log(`${tag}: ${p.symbol} VERIFIED ${result.kind}${result.kind === 'reduced' ? ` (${result.afterLNS} lots remain${result.asAsked ? '' : `, ${result.closedLNS} closed where ${closeLNS} was asked`}${realisedCNS === undefined ? '; fill not reported' : `; realised ${realisedCNS}, fee ${feeCNS ?? 'unknown'}`})` : 'why' in result ? `: ${result.why}` : ''}`);
    try {
      await this.#o.store.record({
        accountId,
        requestId,
        by,
        startedAtMs: this.#now(),
        finishedAtMs: this.#now(),
        requested: [{ symbol: p.symbol, marketId: p.marketId, positionId: p.positionId, side: p.side, sizeLNS: String(closeLNS) }],
        receipts: [{ positionId: p.positionId, outcome: outcome?.kind ?? 'none', receipt, venueRef: outcome !== undefined && outcome.kind !== 'refused' ? outcome.reported.venueRef : undefined }],
        verified: [{ positionId: p.positionId, symbol: p.symbol, kind: `reduce-${result.kind}`, ...(result.kind === 'reduced' ? { remainingLNS: String(result.afterLNS) } : {}), ...('why' in result ? { why: result.why } : {}) }],
      });
    } catch (error) {
      log(`${tag}: the run could not be recorded (${error instanceof Error ? error.message : String(error)}); the log lines above are the record`);
    }
    return { kind: 'ran', position: p, requestedLNS: closeLNS, result, realisedCNS, feeCNS, exitPricePNS, replayed: false };
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
