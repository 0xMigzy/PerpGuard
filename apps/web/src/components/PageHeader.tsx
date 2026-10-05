import type { ReactNode } from 'react';

export function PageHeader({
  title,
  thin,
  subtitle,
  right,
}: {
  readonly title: ReactNode;
  /** A muted tail on the H1, e.g. a short address. */
  readonly thin?: ReactNode;
  readonly subtitle: ReactNode;
  readonly right?: ReactNode;
}) {
  return (
    <div className="page-header mb-[18px] flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="m-0 mb-1 text-[24px] font-bold tracking-[-0.03em] text-balance sm:text-[28px]">
          {title}
          {thin !== undefined && <span className="font-medium text-muted"> {thin}</span>}
        </h1>
        <p className="m-0 max-w-[70ch] text-muted">{subtitle}</p>
      </div>
      {right !== undefined && <div className="flex flex-wrap items-center gap-[10px]">{right}</div>}
    </div>
  );
}
