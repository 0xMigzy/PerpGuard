import { PageHeader } from './PageHeader.tsx';

/** An honest placeholder: the tab exists and deep-links; the page is next in the build order. */
export function ComingNext({ title, subtitle }: { readonly title: string; readonly subtitle: string }) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="rounded-[12px] border border-dashed border-border2 px-[18px] py-4 text-[12.5px] text-muted">
        Not built yet. Overview is finished first; this page follows in the build order.
      </div>
    </>
  );
}
