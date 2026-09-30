import { Suspense } from 'react';
import { MarketsView } from './MarketsView.tsx';

export const metadata = { title: 'Markets' };

export default function MarketsPage() {
  // Suspense: the view reads the URL's search params on the client.
  return (
    <Suspense fallback={null}>
      <MarketsView />
    </Suspense>
  );
}
