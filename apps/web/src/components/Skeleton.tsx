/** A placeholder the size of what is coming. Never a spinner, never a zero. */
export function Skeleton({ className = '' }: { readonly className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}
