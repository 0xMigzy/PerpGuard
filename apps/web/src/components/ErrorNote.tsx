import { describeError } from '@/lib/api.ts';

/** What went wrong and what it means, in a sentence. Never a raw error. */
export function ErrorNote({ error, what }: { readonly error: unknown; readonly what: string }) {
  if (error === undefined) return null;
  return (
    <div role="alert" className="mb-4 rounded-[10px] border border-danger/40 bg-danger/10 px-4 py-3 text-[13px]">
      <b className="text-danger">{what} could not be loaded.</b>{' '}
      <span className="text-muted">{describeError(error)} The last figures shown, if any, are from before this.</span>
    </div>
  );
}
