import type { Envelope } from './api.ts';

/**
 * A page drawn from several answers speaks for the WORST of them: one that is
 * not current if any is, else the oldest. Saying the age of the freshest would
 * let a figure computed an hour ago sit under "computed 2 minutes ago".
 */
export function worstOf(envelopes: readonly (Envelope<unknown> | undefined)[]): Envelope<unknown> | undefined {
  const present = envelopes.filter((e): e is Envelope<unknown> => e !== undefined);
  const stale = present.filter((e) => e.stale).sort((a, b) => b.health.blocksBehind - a.health.blocksBehind)[0];
  if (stale !== undefined) return stale;
  return present.reduce<Envelope<unknown> | undefined>((oldest, e) => (oldest === undefined || e.ageMs > oldest.ageMs ? e : oldest), undefined);
}
