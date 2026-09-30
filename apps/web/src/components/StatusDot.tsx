'use client';

import { api, type HealthReport } from '@/lib/api.ts';
import { formatCount } from '@/lib/format.ts';
import { usePoll } from '@/lib/usePoll.ts';

type Light = 'green' | 'amber' | 'red';

interface Verdict {
  readonly light: Light;
  readonly label: string;
  readonly lines: readonly string[];
}

/**
 * Green only when the feed, the positions and the indexer are ALL live. Amber
 * when any is stale or lagging. Red when any is down — or when we cannot tell,
 * because a blind system must never show green.
 */
export function verdictOf(report: HealthReport | undefined, error: unknown): Verdict {
  if (report === undefined) {
    return {
      light: 'red',
      label: error === undefined ? 'Connecting' : 'Backend unreachable',
      lines: ['Feed: unknown', 'Positions: unknown', 'Indexer: unknown'],
    };
  }
  const c = report.components;
  const feed = c.feed.connection ?? c.feed.state;
  const feedLight: Light = feed === 'connected' ? 'green' : feed === 'reconnecting' ? 'amber' : 'red';
  const positions = c.positions.source ?? c.positions.state;
  const positionsLight: Light = positions === 'live' ? 'green' : positions === 'stale' ? 'amber' : 'red';
  const indexer = c.indexer.indexer ?? c.indexer.state;
  const indexerLight: Light = indexer === 'synced' ? 'green' : indexer === 'lagging' ? 'amber' : 'red';
  const blocks = c.indexer.blocksBehind;
  const lights = [feedLight, positionsLight, indexerLight];
  const light: Light = lights.includes('red') ? 'red' : lights.includes('amber') ? 'amber' : 'green';
  const label =
    light === 'green'
      ? `Live · ${blocks === undefined ? '' : `${formatCount(blocks)} blocks`}`.replace(/ · $/, '')
      : light === 'amber'
        ? 'Lagging'
        : 'Down';
  return {
    light,
    label,
    lines: [
      `Feed: ${feed}`,
      `Positions: ${positions}`,
      `Indexer: ${indexer}${blocks === undefined ? '' : ` · ${formatCount(blocks)} blocks behind`}`,
      ...(report.reasons.length > 0 ? ['', ...report.reasons] : []),
    ],
  };
}

const DOT: Record<Light, string> = {
  green: 'bg-safe shadow-[0_0_0_3px_rgba(61,217,160,0.18)]',
  amber: 'bg-watch shadow-[0_0_0_3px_rgba(245,185,60,0.18)]',
  red: 'bg-danger shadow-[0_0_0_3px_rgba(255,107,128,0.18)]',
};

export function StatusDot() {
  const { data, error } = usePoll(api.health, 3000, 'health');
  const verdict = verdictOf(data, error);
  return (
    <div
      className="flex flex-none items-center gap-2 rounded-[10px] border border-border2 bg-card px-[10px] py-[7px] text-[12px] text-muted"
      title={verdict.lines.join('\n')}
      aria-live="polite"
    >
      <span className={`h-2 w-2 rounded-full ${DOT[verdict.light]}`} aria-hidden="true" />
      <span className="num hidden sm:inline">{verdict.label}</span>
      <span className="sr-only">{verdict.lines.join('. ')}</span>
    </div>
  );
}
