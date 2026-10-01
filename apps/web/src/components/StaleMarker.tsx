import type { Envelope } from '@/lib/api.ts';
import { blocksToApproxMs, formatAge, formatCount } from '@/lib/format.ts';

/**
 * The one thing every analytics envelope must render: whether its numbers are
 * current. Nothing when they are. When they are not, how far behind and why —
 * and the figures around it stay visible, because a blank dashboard helps nobody.
 */
export function StaleMarker({ envelope }: { readonly envelope: Envelope<unknown> | undefined }) {
  if (envelope === undefined) return null;
  if (!envelope.stale) return <ComputedAge envelope={envelope} />;
  const blocks = envelope.health.blocksBehind;
  const behind = blocksToApproxMs(blocks);
  return (
    <div
      role="status"
      className="mb-4 rounded-[10px] border border-watch/40 bg-watch/10 px-4 py-3 text-[13px]"
    >
      <b className="text-watch">Data is about {formatAge(behind)} behind.</b>{' '}
      <span className="text-muted">
        The indexer is {envelope.health.state}, {formatCount(blocks)} blocks behind the chain. These figures
        are real but not current.
        {envelope.staleReason !== undefined && ` ${envelope.staleReason}`}
      </span>
    </div>
  );
}

/** Past this age an answer is labelled with when it was computed. Under it, nothing. */
const SHOW_AGE_AFTER_MS = 45_000;

/**
 * How old a cached answer is, when that is worth saying.
 *
 * The backend serves the last computed figures immediately and refreshes them
 * behind the page, so a reader can be looking at numbers computed a minute ago.
 * Said in words, only once it matters, and never as a warning: a minute-old
 * aggregate over indexed history is not stale data, it is a cache working.
 */
function ComputedAge({ envelope }: { readonly envelope: Envelope<unknown> }) {
  if (envelope.ageMs < SHOW_AGE_AFTER_MS) return null;
  return (
    <div role="status" className="mb-3 text-[12.5px] text-muted">
      Figures computed {formatAge(envelope.ageMs)} ago{envelope.revalidating ? '; refreshing' : ''}.
    </div>
  );
}
