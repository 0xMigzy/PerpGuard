import { Suspense } from 'react';
import { LiquidationsView } from './LiquidationsView.tsx';

export const metadata = { title: 'Liquidations' };

export default function LiquidationsPage() {
  // Suspense: the view reads the URL's search params on the client.
  return (
    <Suspense fallback={null}>
      <LiquidationsView />
    </Suspense>
  );
}
