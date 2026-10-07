/**
 * 🔴 KILL SWITCH, the bot's half (Phase 20, spec 54-57). Stop automation,
 * leave positions open. The bot reads and flips it only through
 * `KillSwitchControl`, which the backend implements over the persisted flag.
 *
 * REACHABLE WITHOUT A SESSION: these routes resolve the chat's LINK, never its
 * session, so a stop works when the trading account is down, the key needs
 * re-linking or the socket is gone (spec 54: stopping must never need a new
 * authorization).
 *
 *   56  the switch: what it does, STOP AUTOMATION / Cancel
 *       then ⚠️ CONFIRM EMERGENCY STOP: account, active strategy, CONFIRM / Cancel
 *   57  the result, as a NEW message (the record of what was stopped):
 *       Rescue OFF, Copy Trading OFF, new automated actions BLOCKED, positions UNCHANGED
 *
 * While stopped, the same button shows STOPPED and offers Resume, which lifts
 * the block only: every strategy stays off until the person turns it on.
 */
import { esc } from '@perpguard/backend/alerts/plain';
import type { Button, Screen } from './screens.ts';

export interface StopReportView {
  readonly alreadyStopped: boolean;
  readonly rescueStopped: readonly string[];
  readonly copyStopped?: { readonly leaderAccountId: number; readonly openCopies: number } | undefined;
  readonly modeBefore: string;
  readonly inFlight: 'none' | 'stopped-before-send' | 'already-sent' | 'still-settling';
  readonly inFlightDetail: string | undefined;
}

export interface KillSwitchControl {
  stopped(accountId: number): boolean;
  changedAtMs(accountId: number): number | undefined;
  stop(accountId: number, by: string): Promise<StopReportView>;
  resume(accountId: number, by: string): Promise<{ readonly wasStopped: boolean }>;
}

const HOME: Button = { text: '🏠 Main Menu', route: { to: 'home' } };
const when = (ms: number | undefined): string => (ms === undefined ? '' : ` since ${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`);

/** Spec 56, or the stopped state with Resume. */
export function killSwitchScreen(input: { readonly accountId: number; readonly stopped: boolean; readonly changedAtMs: number | undefined; readonly rescueOn: readonly string[] }): Screen {
  if (input.stopped) {
    return {
      html: [
        `🛑 <b>PERPGUARD STOPPED</b>${when(input.changedAtMs)}`,
        '',
        `Trading Account: <b>#${input.accountId}</b>`,
        'New automated actions: 🔴 <b>BLOCKED</b>',
        'Liquidation Rescue: ⚪ OFF',
        'Copy Trading: ⚪ OFF',
        '',
        'Your positions were not touched, and you can still add margin, reduce or close them yourself.',
      ].join('\n'),
      buttons: [[{ text: '▶️ Resume automation', route: { to: 'kill-resume-ask' } }], [HOME]],
    };
  }
  return {
    html: [
      '🔴 <b>EMERGENCY KILL SWITCH</b>',
      '',
      'Immediately stop PerpGuard automated trading.',
      '',
      'This will:',
      '• stop Liquidation Rescue',
      '• stop Copy Trading',
      '• block new automated actions',
      '• cancel bot-managed pending orders where supported (PerpGuard places none today: Rescue adds margin directly)',
      '',
      '<b>Existing positions remain open.</b> Nothing is closed, reduced or sold.',
      input.rescueOn.length === 0 ? '' : `\nRunning now: 🛟 Liquidation Rescue on ${input.rescueOn.map(esc).join(', ')}`,
    ]
      .filter((l) => l !== '')
      .join('\n'),
    buttons: [[{ text: '🔴 STOP AUTOMATION', route: { to: 'kill-confirm' } }], [{ text: 'Cancel', route: { to: 'home' } }]],
  };
}

/** Spec 56's second screen: the confirmation. */
export function killConfirmScreen(input: { readonly accountId: number; readonly wallet: string | undefined; readonly rescueOn: readonly string[] }): Screen {
  const strategy = input.rescueOn.length === 0 ? '⚪ None running' : `🛟 Liquidation Rescue (${input.rescueOn.map(esc).join(', ')})`;
  return {
    html: [
      '⚠️ <b>CONFIRM EMERGENCY STOP</b>',
      '',
      `Trading Account: <b>#${input.accountId}</b>${input.wallet === undefined ? '' : ` · ${esc(input.wallet)}`}`,
      `Active Strategy: ${strategy}`,
      '',
      'Positions stay open.',
    ].join('\n'),
    buttons: [[{ text: '🔴 CONFIRM STOP', route: { to: 'kill-stop' }, fresh: true }], [{ text: 'Cancel', route: { to: 'kill' } }]],
  };
}

/** Spec 57: the result, a record. */
export function killResultScreen(report: StopReportView): Screen {
  const inFlight: Record<StopReportView['inFlight'], string | undefined> = {
    none: undefined,
    'stopped-before-send': 'A rescue that was about to send was stopped at the last check. Nothing was sent.',
    'already-sent': 'A rescue had already been sent before the stop. It cannot be recalled; it was checked against the position like any other.',
    'still-settling': 'A rescue was being sent at the moment of the stop and is still being checked against the position. Look at the position before adding anything.',
  };
  const lines = [
    '🛑 <b>PERPGUARD STOPPED</b>',
    '',
    `Liquidation Rescue: ⚪ OFF${report.rescueStopped.length === 0 ? '' : ` (turned off on ${report.rescueStopped.map(esc).join(', ')})`}`,
    report.copyStopped === undefined
      ? 'Copy Trading: ⚪ OFF'
      : `Copy Trading: ⚪ OFF (stopped copying #${report.copyStopped.leaderAccountId}; ${report.copyStopped.openCopies} copied position${report.copyStopped.openCopies === 1 ? '' : 's'} left open)`,
    'New automated actions: 🔴 <b>BLOCKED</b>',
    'Existing positions: <b>UNCHANGED</b>',
    'Pending orders: none were PerpGuard’s to cancel',
  ];
  if (report.alreadyStopped) lines.push('', 'It was already stopped; nothing else changed.');
  const note = inFlight[report.inFlight];
  if (note !== undefined) lines.push('', note);
  return { html: lines.join('\n'), buttons: [[{ text: '📊 View Positions', route: { to: 'positions' } }, HOME]] };
}

export function killResumeAskScreen(): Screen {
  return {
    html: [
      '▶️ <b>RESUME AUTOMATION?</b>',
      '',
      'This lifts the block on automated actions.',
      'Nothing starts by itself: Liquidation Rescue stays off on every position, and Copy Trading stays off, until you turn them on again.',
    ].join('\n'),
    buttons: [[{ text: '▶️ Resume', route: { to: 'kill-resume' } }], [{ text: 'Cancel', route: { to: 'kill' } }]],
  };
}

export function killResumedScreen(wasStopped: boolean): Screen {
  return {
    html: wasStopped
      ? ['▶️ <b>AUTOMATION RESUMED</b>', '', 'New automated actions are allowed again. Rescue is still off on every position: turn it on per position under 🛟 Rescue.'].join('\n')
      : 'Automation was not stopped, so nothing changed.',
    buttons: [[{ text: '🛟 Rescue', route: { to: 'rescue' } }, HOME]],
  };
}
