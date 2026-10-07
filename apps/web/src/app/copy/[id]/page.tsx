import { Suspense } from 'react';
import { CopyView } from './CopyView.tsx';

export const metadata = { title: 'Copy replay' };

export default async function CopyPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div data-ui="terminal">
      {/* Suspense: the view reads the size from the URL's search params on the client. */}
      <Suspense fallback={null}>
        <CopyView accountId={Number(id)} />
      </Suspense>
    </div>
  );
}
