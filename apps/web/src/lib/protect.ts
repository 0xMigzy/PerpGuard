/**
 * Pure helpers for the Protect page. No I/O, no React, and NO RISK MATHS: every
 * buffer, price and amount here arrived from the backend. These only decide
 * where to draw things and which words to use.
 */
import type { ProtectPosition, ProtectProgress, RiskState } from '@perpguard/backend/protect';

export type Tier = 'past' | 'danger' | 'watch' | 'safe' | 'blind';

export function tierOf(state: RiskState): Tier {
  switch (state) {
    case 'PAST_LIQUIDATION':
      return 'past';
    case 'DANGER':
      return 'danger';
    case 'WATCH':
      return 'watch';
    case 'SAFE':
      return 'safe';
    case 'FEED_DOWN':
    case 'POSITIONS_UNTRUSTED':
      return 'blind';
  }
}

/** The three bands of the runway meter, as fractions of the track. */
export const METER = { dangerEnd: 0.2, watchEnd: 0.5 } as const;

/**
 * Where the marker sits on the runway meter, 0..1.
 *
 * The track is not linear: the danger band (0 to `dangerPct`) takes the first
 * fifth, watch (to `watchPct`) the next three tenths, and everything up to 20%
 * the rest, so a 2.7% buffer sits visibly inside the red rather than at the
 * left edge. NEGATIVE IS ZERO: past liquidation has no runway to draw.
 */
export function meterPosition(liqBufferPct: number | undefined, dangerPct: number, watchPct: number): number {
  if (liqBufferPct === undefined || liqBufferPct <= 0) return 0;
  if (liqBufferPct < dangerPct) return (liqBufferPct / dangerPct) * METER.dangerEnd;
  if (liqBufferPct < watchPct) return METER.dangerEnd + ((liqBufferPct - dangerPct) / (watchPct - dangerPct)) * (METER.watchEnd - METER.dangerEnd);
  const top = 0.2;
  return Math.min(1, METER.watchEnd + ((liqBufferPct - watchPct) / (top - watchPct)) * (1 - METER.watchEnd));
}

/** The position nearest liquidation among the ones we can see. Negative buffers sort first. */
export function closestToLiquidation(positions: readonly ProtectPosition[]): ProtectPosition | undefined {
  return positions
    .filter((p) => p.liqBufferPct !== undefined && tierOf(p.state) !== 'blind')
    .sort((a, b) => a.liqBufferPct! - b.liqBufferPct!)[0];
}

export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface Step {
  readonly label: string;
  readonly status: StepStatus;
  readonly note?: string;
}

/**
 * The three steps as they ACTUALLY stand. Nothing is ticked ahead of the
 * backend: "accepted by the forwarder" is done only once the venue replied,
 * and it says "no reply" or "call failed" when that is what happened.
 */
export function stepsFor(progress: ProtectProgress | undefined): readonly Step[] {
  const stage = progress?.stage ?? 'queued';
  const reported = progress?.reported;
  const sent: StepStatus = stage === 'queued' ? 'pending' : stage === 'sending' ? 'active' : 'done';
  let accepted: Step;
  if (stage === 'queued' || stage === 'sending') {
    accepted = { label: 'Waiting for the venue\u2019s reply · mt 3 is acceptance for forwarding, not settlement', status: stage === 'sending' ? 'active' : 'pending' };
  } else if (reported === undefined) {
    accepted = { label: 'No venue reply: nothing was sent', status: 'skipped' };
  } else if (reported.status === 'timeout') {
    accepted = { label: 'No reply from the venue', status: 'failed', note: 'not a failure: reconciled against the position instead' };
  } else if (reported.status === 'threw') {
    accepted = { label: 'The venue call failed', status: 'failed', note: 'reconciled against the position anyway' };
  } else {
    accepted = { label: `Venue replied: ${reported.status}${reported.reason === undefined ? '' : ` · ${reported.reason}`}`, status: 'done', note: 'a reply is not the outcome' };
  }
  const reconciled: StepStatus = stage === 'settled' ? 'done' : stage === 'reconciling' ? 'active' : 'pending';
  return [
    { label: 'Signed locally with your API key and sent once', status: sent },
    accepted,
    { label: 'Reconciled against the position', status: reconciled },
  ];
}

/**
 * Whether the venue's word and the position's word disagree, which is the
 * case worth pointing at: sr 32 is "Failed" beside "applied".
 */
export function venueDisagrees(progress: ProtectProgress): boolean {
  const o = progress.outcome;
  if (o === undefined || o.kind === 'kill-switch' || o.reported === undefined || o.reconciliation === undefined) return false;
  const saidYes = o.reported.status === 'confirmed' || o.reported.status === 'forwarded';
  const saidNo = o.reported.status === 'rejected';
  return (saidNo && o.reconciliation.verdict === 'applied') || (saidYes && o.reconciliation.verdict === 'not-applied');
}

/** Who started an in-flight action, as far as this page can tell from its key. */
export function inFlightSource(idempotencyKey: string, mine: ReadonlySet<string>): 'here' | 'elsewhere' {
  if (mine.has(idempotencyKey)) return 'here';
  return 'elsewhere';
}
