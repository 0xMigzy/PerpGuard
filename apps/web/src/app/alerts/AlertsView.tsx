'use client';

import { PageHeader } from '@/components/PageHeader.tsx';

/** Alerts are delivered to Telegram. This section explains the two tiers; nothing here acts. */
export function AlertsView() {
  return (
    <>
      <PageHeader title="Alerts" subtitle="Alerts are delivered to Telegram. This is where the two tiers are explained, and what each one receives." />
      <div className="rounded-[12px] border border-dashed border-border2 px-[18px] py-4 text-[12.5px] text-muted">
        Structure only. The two tiers and the example bot messages land next.
      </div>
    </>
  );
}
