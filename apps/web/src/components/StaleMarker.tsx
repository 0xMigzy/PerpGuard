import type { Envelope } from '@/lib/api.ts';
import { blocksToApproxMs, formatAge, formatCount } from '@/lib/format.ts';

/**
 * The one thing every analytics envelope must render: whether its numbers are
 * current. Nothing when they are. When they are not, how far behind and why —
 * and the figures around it stay visible, because a blank dashboard helps nobody.
 */
export function StaleMarker({ envelope }: { readonly envelope: Envelope<unknown> | undefined }) {
  if (envelope === undefined || !envelope.stale) return null;
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
