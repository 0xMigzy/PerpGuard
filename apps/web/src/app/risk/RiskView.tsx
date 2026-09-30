'use client';

import { PageHeader } from '@/components/PageHeader.tsx';

/**
 * Risk is a POINT-IN-TIME SNAPSHOT: contract state at one block, so it has no
 * timeframe control. The header carries the block instead.
 */
export function RiskView() {
  return (
    <>
      <PageHeader
        title="Risk"
        subtitle="Liquidation exposure of every open position, from contract state at the latest indexed block."
        right={<span className="chip">Contract state at block —</span>}
      />
      <div className="rounded-[12px] border border-dashed border-border2 px-[18px] py-4 text-[12.5px] text-muted">
        Structure only. Tiles, the stress test, the liquidation ladder, the largest exposed positions and the by-market table land next.
      </div>
    </>
  );
}
