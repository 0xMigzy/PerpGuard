/**
 * 🆘 KILL SWITCH, the stop half: Stop automation only (owner, 8 Oct 2026).
 * Leaves positions open. The bot reads and flips it only through
 * `KillSwitchControl`, which the backend implements over the persisted flag.
 *
 * REACHABLE WITHOUT A SESSION: these routes resolve the chat's LINK, never its
 * session, so a stop works when the trading account is down, the key needs
 * re-linking or the socket is gone — the day it is needed most. While
 * stopped, Resume lifts the block only: every rule stays off until the person
 * turns it on. Stop everything (stop, then close all) is `emergency.ts`.
 */
import { esc } from '@perpguard/backend/alerts/plain';
import type { Button, Screen } from './screens.ts';

export interface StopReportView {
  readonly alreadyStopped: boolean;
  readonly rescueStopped: readonly string[];
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

const MENU: Button = { text: '🏠 Menu', route: { to: 'home' } };

/**
 * STOP AUTOMATION ONLY, confirmed by a tap on a screen that says what stops.
 * Local and instant: it needs nothing from the exchange.
 */
export function killConfirmScreen(input: { readonly rescueOn: readonly string[] }): Screen {
  return {
    html: [
      '<b>Stop automation only?</b>',
      '',
      input.rescueOn.length === 0 ? 'Nothing automatic is running right now; this keeps it that way until you resume.' : `Rescue turns off on ${input.rescueOn.map(esc).join(', ')}, and nothing automatic runs until you resume.`,
      'Your positions stay open. This works even if the exchange is unreachable.',
    ].join('\n'),
    buttons: [[{ text: 'Yes, stop automation', route: { to: 'kill-stop' }, fresh: true }], [{ text: 'Cancel', route: { to: 'kill' } }]],
  };
}

/** The result, a record: what stopped, and that positions were not touched. */
export function killResultScreen(report: StopReportView): Screen {
  const inFlight: Record<StopReportView['inFlight'], string | undefined> = {
    none: undefined,
    'stopped-before-send': 'A top-up that was about to go was stopped at the last check. Nothing was sent.',
    'already-sent': "A top-up had already gone before the stop. It can't be recalled; I checked it against the position like any other.",
    'still-settling': "A top-up was going out at the moment of the stop and I'm still checking it against the position. Look at the position before adding anything.",
  };
  const lines = [
    '🛑 <b>Automation stopped.</b>',
    report.rescueStopped.length === 0 ? 'Nothing automatic will run until you resume.' : `Rescue is off on ${report.rescueStopped.map(esc).join(', ')}. Nothing automatic will run until you resume.`,
    'Your positions are still open.',
  ];
  if (report.alreadyStopped) lines.push('', 'It was already stopped; nothing else changed.');
  const note = inFlight[report.inFlight];
  if (note !== undefined) lines.push('', note);
  return { html: lines.join('\n'), buttons: [[{ text: '📊 My positions', route: { to: 'positions' } }, MENU]] };
}

export function killResumeAskScreen(): Screen {
  return {
    html: ['▶️ <b>Resume automation?</b>', '', "This lifts the stop. Nothing starts by itself: Rescue stays off on every position until you turn it on again."].join('\n'),
    buttons: [[{ text: '▶️ Resume', route: { to: 'kill-resume' } }], [{ text: 'Cancel', route: { to: 'kill' } }]],
  };
}

export function killResumedScreen(wasStopped: boolean): Screen {
  return {
    html: wasStopped ? '▶️ <b>Automation resumed.</b>\nRescue is still off on every position. Turn it on per position under 🛟 Rescue.' : "Automation wasn't stopped, so nothing changed.",
    buttons: [[{ text: '🛟 Rescue', route: { to: 'rescue' } }, MENU]],
  };
}
