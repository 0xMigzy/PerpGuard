import type { ReactNode } from 'react';

/**
 * Explanations live behind a toggle, never in the way: the facts stay on the
 * page, one tap away. Native <details>, so it works without script and with a
 * keyboard. Anything that signals a PROBLEM (a gap outside the known one, a
 * failed scan, a mismatch) is NOT put behind this; it stays visible.
 */
export function Explain({ children, label = 'How this is calculated', className = '' }: { readonly children: ReactNode; readonly label?: string; readonly className?: string }) {
  return (
    <details className={`explain group text-[11.5px] leading-[1.55] text-muted2 ${className}`}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-muted hover:text-text [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">›</span>
        {label}
      </summary>
      <div className="mt-1">{children}</div>
    </details>
  );
}

/**
 * One short plain line, with the full text behind "details" at its end.
 * "Matches the contract to within $27.70 · details".
 */
export function ShortLine({ line, children, className = '' }: { readonly line: ReactNode; readonly children: ReactNode; readonly className?: string }) {
  return (
    <details className={`explain group text-[11.5px] leading-[1.55] text-muted2 ${className}`}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="text-muted">{line}</span>
        <span className="text-muted"> · </span>
        <span className="text-muted underline decoration-border2 underline-offset-2 hover:text-text">
          <span className="group-open:hidden">details</span>
          <span className="hidden group-open:inline">hide</span>
        </span>
      </summary>
      <div className="mt-1">{children}</div>
    </details>
  );
}
