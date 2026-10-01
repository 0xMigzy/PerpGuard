/**
 * "Warn me at": how early a linked account's FIRST warning arrives.
 *
 * Three plain choices rather than a number to invent. Each moves only the
 * WATCH band — when the first warning fires and when it clears. DANGER stays
 * at 3% (clearing at 4%) for every level, because DANGER is the alert a
 * setting must never be able to delay.
 *
 *   early        WATCH at 10%, clears at 11%   most time to react
 *   normal       WATCH at  8%, clears at  9%   the default, unchanged
 *   last-minute  no WATCH band: the first message is DANGER at 3%
 *
 * "Last minute" sets WATCH's bounds equal to DANGER's, which empties the band
 * cleanly: below 3% is DANGER, above it nothing, and DANGER clears at 4% —
 * the state machine's ordering (watch >= danger) still holds.
 *
 * Pure. The account's risk loop applies the thresholds; a settings store
 * remembers the level.
 */
import { DEFAULT_THRESHOLDS, type RiskThresholds } from './types.ts';

export type WarnLevel = 'early' | 'normal' | 'last-minute';

export interface WarnLevelInfo {
  readonly level: WarnLevel;
  /** Wire index for a button: 0, 1, 2. */
  readonly index: number;
  readonly label: string;
  /** Where the first warning fires, as a fraction. */
  readonly firstWarningPct: number;
  readonly note: string;
}

export const WARN_LEVELS: readonly WarnLevelInfo[] = [
  { level: 'early', index: 0, label: 'Early', firstWarningPct: 0.1, note: 'most time to react' },
  { level: 'normal', index: 1, label: 'Normal', firstWarningPct: DEFAULT_THRESHOLDS.watchEnterPct, note: 'the default' },
  { level: 'last-minute', index: 2, label: 'Last minute', firstWarningPct: DEFAULT_THRESHOLDS.dangerEnterPct, note: 'fewest messages' },
];

export const DEFAULT_WARN_LEVEL: WarnLevel = 'normal';

export function warnLevelInfo(level: WarnLevel): WarnLevelInfo {
  return WARN_LEVELS.find((l) => l.level === level) as WarnLevelInfo;
}

export function warnLevelByIndex(index: number): WarnLevel | undefined {
  return WARN_LEVELS.find((l) => l.index === index)?.level;
}

/** The loop thresholds a level means. DANGER's are never touched. */
export function thresholdsFor(level: WarnLevel): RiskThresholds {
  const t = DEFAULT_THRESHOLDS;
  switch (level) {
    case 'early':
      return { ...t, watchEnterPct: 0.1, watchExitPct: 0.11 };
    case 'normal':
      return { ...t };
    case 'last-minute':
      return { ...t, watchEnterPct: t.dangerEnterPct, watchExitPct: t.dangerExitPct };
  }
}
