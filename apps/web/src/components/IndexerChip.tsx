'use client';

import type { IndexerHealth } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatCount } from '@/lib/format.ts';
import { usePoll } from '@/lib/usePoll.ts';

type Light = 'green' | 'amber' | 'red';

interface Verdict {
  readonly light: Light;
  readonly label: string;
  readonly detail: string;
}

/**
 * The one health that matters to a public analytics page: the indexer's.
 *
 * Green only when it is synced against an independent chain head. Amber when it
 * is lagging. Red when it is halted, unknown or unreachable — a blind page must
 * never show green. The label carries the block the numbers came from, so a
 * reader can see how current "now" is.
 */
export function verdictOf(health: IndexerHealth | undefined, error: unknown): Verdict {
  if (health === undefined) {
    return {
      light: 'red',
      label: error === undefined ? 'Connecting' : 'Backend unreachable',
      detail: error === undefined ? 'Waiting for the first health reading.' : 'The analytics backend did not answer, so nothing on this page is current.',
    };
  }
  const block = health.latestProcessedBlock === undefined ? undefined : formatCount(health.latestProcessedBlock);
  const behind = `${formatCount(health.blocksBehind)} block${health.blocksBehind === 1 ? '' : 's'} behind`;
  if (health.serveAsCurrent) {
    return { light: 'green', label: block ?? 'Live', detail: `Indexer synced · ${behind} · figures are current` };
  }
  if (health.state === 'lagging') {
    return { light: 'amber', label: block === undefined ? 'Lagging' : `${block} · lagging`, detail: `Indexer lagging · ${behind} · ${health.reason ?? 'figures are real but not current'}` };
  }
  return { light: 'red', label: block === undefined ? health.state : `${block} · ${health.state}`, detail: `Indexer ${health.state} · ${behind} · ${health.reason ?? 'figures are frozen'}` };
}

const DOT: Record<Light, string> = {
  green: 'bg-safe shadow-[0_0_0_3px_rgba(61,217,160,0.18)]',
  amber: 'bg-watch shadow-[0_0_0_3px_rgba(245,185,60,0.18)]',
  red: 'bg-danger shadow-[0_0_0_3px_rgba(255,107,128,0.18)]',
};

export function IndexerChip() {
  const { data, error } = usePoll(api.indexerHealth, 10_000, 'indexer-health');
  const verdict = verdictOf(data?.data, error);
  return (
    <div
      className="indexer-chip flex flex-none items-center gap-2 rounded-[10px] border border-border2 bg-card px-[10px] py-[7px] text-[12px] text-muted"
      title={verdict.detail}
      aria-live="polite"
    >
      <span className={`h-2 w-2 rounded-full ${DOT[verdict.light]}`} aria-hidden="true" />
      <span className="num hidden sm:inline">{verdict.label}</span>
      <span className="sr-only">{verdict.detail}</span>
    </div>
  );
}
