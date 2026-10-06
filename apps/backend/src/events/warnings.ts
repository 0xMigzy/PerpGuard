/**
 * Liquidation warning levels for WATCHED wallets (spec 27). Pure.
 *
 * A level is a distance from the closing price, in percent: "warn me at 10%
 * and 5%". It fires ONCE when the distance falls to it, then stays quiet
 * until the position RECOVERS past it by a margin (a quarter of the level,
 * at least half a point: 5% re-arms at 6.25%), so a price wobbling around a
 * line cannot send a message on every pass.
 *
 * Several levels crossed at once is ONE message, at the most severe of them:
 * a fall from 25% to 4% says "5%", not three things in a row.
 *
 * Presets, plus Custom: up to five levels, each above 0 and at most 100,
 * sorted highest first. Off is no levels. Your own linked account keeps
 * "Warn me at" (risk/warn.ts), which drives the money buttons; the two are
 * unified when the account screens are rebuilt (Phases 13-14).
 */
export const WARNING_PRESETS = {
  early: [20, 10, 5],
  standard: [10, 5],
  late: [5, 2],
} as const;
export type WarningPreset = keyof typeof WARNING_PRESETS;
export const DEFAULT_WARNING_LEVELS: readonly number[] = WARNING_PRESETS.standard;
export const MAX_CUSTOM_LEVELS = 5;

/** Where a fired level arms again. */
export const rearmAt = (level: number): number => level + Math.max(0.5, level * 0.25);

/** The preset these levels are, if any. */
export function presetOf(levels: readonly number[]): WarningPreset | 'off' | 'custom' {
  if (levels.length === 0) return 'off';
  for (const [name, preset] of Object.entries(WARNING_PRESETS)) {
    if (preset.length === levels.length && preset.every((l, i) => l === levels[i])) return name as WarningPreset;
  }
  return 'custom';
}

/** "10% / 5%". */
export const levelsLabel = (levels: readonly number[]): string => (levels.length === 0 ? 'Off' : levels.map((l) => `${l}%`).join(' / '));

/** A typed list of levels -> sorted, checked levels, or what is wrong with it in one sentence. */
export function parseCustomLevels(text: string): { readonly levels: readonly number[] } | { readonly error: string } {
  const parts = text.split(/[\s,;/]+/).map((p) => p.replace(/%$/, '')).filter((p) => p !== '');
  if (parts.length === 0) return { error: 'Send one to five numbers, like 15 8 3.' };
  if (parts.length > MAX_CUSTOM_LEVELS) return { error: `At most ${MAX_CUSTOM_LEVELS} levels.` };
  const levels: number[] = [];
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return { error: `"${p}" is not a number.` };
    const n = Number(p);
    if (!(n > 0 && n <= 100)) return { error: 'Each level must be above 0 and at most 100.' };
    if (levels.includes(n)) return { error: `${n}% is there twice.` };
    levels.push(n);
  }
  return { levels: levels.sort((a, b) => b - a) };
}

/**
 * One position, one pass. `distancePct` is SIGNED (negative: past the closing
 * price, which crosses every level). `disarmed` is the levels that have fired
 * and not yet re-armed. Returns the level to warn at now, if any, and the new
 * disarmed set.
 */
export function evaluateWarning(levels: readonly number[], distancePct: number, disarmed: readonly number[]): { readonly fire: number | undefined; readonly disarmed: readonly number[] } {
  const stillDisarmed = disarmed.filter((l) => levels.includes(l) && distancePct < rearmAt(l));
  const crossed = levels.filter((l) => distancePct <= l);
  const fresh = crossed.filter((l) => !stillDisarmed.includes(l));
  return {
    fire: fresh.length === 0 ? undefined : Math.min(...fresh),
    disarmed: [...new Set([...stillDisarmed, ...crossed])].sort((a, b) => b - a),
  };
}

/** How severe a fired level is, among the chat's levels: the lowest is critical. */
export function severityOf(level: number, levels: readonly number[], distancePct: number): { readonly dot: '🔴' | '🟠' | '🟡'; readonly word: 'CRITICAL' | 'HIGH' | 'MEDIUM' } {
  const ascending = [...levels].sort((a, b) => a - b);
  if (distancePct <= 0 || level === ascending[0]) return { dot: '🔴', word: 'CRITICAL' };
  if (level === ascending[1]) return { dot: '🟠', word: 'HIGH' };
  return { dot: '🟡', word: 'MEDIUM' };
}
