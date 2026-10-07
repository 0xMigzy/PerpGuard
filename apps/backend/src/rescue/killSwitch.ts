/**
 * 🔴 THE KILL SWITCH (Phase 20, spec 54-57, 59, 80): STOP AUTOMATION, LEAVE
 * POSITIONS OPEN. It sits above every strategy:
 *
 *   1. the persisted flag goes on FIRST (`automation_state.kill_switch_active`).
 *      From that write, every automated path refuses: Rescue's `decide`, its
 *      pre-claim check, and the executor's last gate right before the send;
 *   2. every Rescue rule on the account is turned off;
 *   3. the automation mode goes to NONE, whichever strategy held it (Copy
 *      Trading included, the day it exists);
 *   4. PerpGuard-managed pending orders: there are none to cancel. Rescue adds
 *      margin directly (no resting order) and Copy Trading is not built. Said
 *      in the report as a fact, not skipped;
 *   5. a rescue already in flight is waited on and REPORTED: stopped at the
 *      last gate before sending, or already sent before the switch (a sent
 *      top-up cannot be recalled; it is reconciled like any other).
 *
 * It NEVER closes, reduces or removes margin from anything, and it needs no
 * session, no socket and no key: it writes to the database and nothing else,
 * so it works when the trading account is down (spec 54). A person's own taps
 * still work while it is on: it stops automation, never the person.
 *
 * Idempotent: a second stop reports that it was already stopped and changes
 * nothing. RESUME only lifts the block; every strategy stays off until the
 * person turns it back on.
 */
import type { AutomationStore } from './automation.ts';
import type { RescueEngine } from './engine.ts';
import type { RescueStore } from './store.ts';

export interface StopReport {
  readonly accountId: number;
  /** It was already on: nothing changed. */
  readonly alreadyStopped: boolean;
  /** Markets whose Rescue rules this stop turned off. */
  readonly rescueStopped: readonly string[];
  /** The strategy that held the account before the stop. */
  readonly modeBefore: string;
  /** What became of a rescue that was in flight at the moment of the stop. */
  readonly inFlight: 'none' | 'stopped-before-send' | 'already-sent' | 'still-settling';
  readonly inFlightDetail: string | undefined;
  readonly atMs: number;
}

export interface KillSwitchOptions {
  readonly automation: AutomationStore;
  readonly rescueStore: RescueStore;
  readonly rescueEngine: Pick<RescueEngine, 'inFlightOn' | 'settleAccount'>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /** How long to wait for a rescue in flight to settle before reporting it as still settling. */
  readonly settleWaitMs?: number;
}

export class KillSwitch {
  readonly #o: KillSwitchOptions;
  readonly #now: () => number;

  constructor(options: KillSwitchOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  stopped(accountId: number): boolean {
    return this.#o.automation.automationStopped(accountId);
  }

  /** When the switch was last flipped, either way. */
  changedAtMs(accountId: number): number | undefined {
    const at = this.#o.automation.get(accountId).updatedAtMs;
    return at > 0 ? at : undefined;
  }

  async stop(accountId: number, by: string): Promise<StopReport> {
    const { automation, rescueStore, rescueEngine, log } = this.#o;
    const alreadyStopped = automation.automationStopped(accountId);
    const modeBefore = automation.get(accountId).mode;
    const wasInFlight = rescueEngine.inFlightOn(accountId);

    // 1. THE FLAG FIRST. Everything automated reads it; nothing below can race ahead of it.
    if (!alreadyStopped) await automation.setKillSwitch(accountId, true);

    // 2. Every Rescue rule off.
    const rescueStopped: string[] = [];
    for (const rule of rescueStore.rulesFor(accountId)) {
      if (!rule.enabled) continue;
      await rescueStore.update(rule.id, { enabled: false, pausedReason: 'kill switch' });
      rescueStopped.push(rule.symbol);
    }

    // 3. No strategy holds the account.
    if (modeBefore !== 'NONE') await automation.transition(accountId, modeBefore, 'NONE');

    // 5. A rescue in flight: wait, then say what it became.
    let inFlight: StopReport['inFlight'] = 'none';
    let inFlightDetail: string | undefined;
    if (wasInFlight) {
      const settled = await rescueEngine.settleAccount(accountId, this.#o.settleWaitMs ?? 20_000);
      // The attempt that was in flight is the account's newest one.
      const latest = rescueStore
        .rulesFor(accountId)
        .flatMap((r) => rescueStore.attempts(r.id))
        .sort((x, y) => y.triggeredAtMs - x.triggeredAtMs)[0];
      if (!settled) {
        inFlight = 'still-settling';
        inFlightDetail = 'a rescue was being sent at the moment of the stop and is still being checked against the position';
      } else if (latest?.outcome === 'refused' && latest.receiptReason === 'automation-stopped') {
        inFlight = 'stopped-before-send';
        inFlightDetail = `rescue ${latest.idempotencyKey} was stopped at the last check before sending; nothing was sent`;
      } else if (latest !== undefined) {
        inFlight = 'already-sent';
        inFlightDetail = `a rescue had already been sent before the stop (${latest.idempotencyKey}, outcome ${latest.outcome ?? 'being checked'})`;
      }
    }

    const report: StopReport = { accountId, alreadyStopped, rescueStopped, modeBefore, inFlight, inFlightDetail, atMs: this.#now() };
    log(
      `KILL SWITCH ${alreadyStopped ? 'pressed again (already on)' : 'ON'} for account ${accountId} by ${by}: ` +
        `mode ${modeBefore} -> NONE; Rescue off on ${rescueStopped.length === 0 ? 'nothing' : rescueStopped.join(', ')}; ` +
        `in flight: ${inFlight}${inFlightDetail === undefined ? '' : ` (${inFlightDetail})`}; positions untouched`,
    );
    return report;
  }

  /** Lifts the block. Every strategy stays off until the person turns it back on. */
  async resume(accountId: number, by: string): Promise<{ readonly wasStopped: boolean }> {
    const wasStopped = this.#o.automation.automationStopped(accountId);
    if (wasStopped) await this.#o.automation.setKillSwitch(accountId, false);
    this.#o.log(`KILL SWITCH ${wasStopped ? 'OFF' : 'off already'} for account ${accountId} by ${by}; strategies stay off until turned on`);
    return { wasStopped };
  }
}
