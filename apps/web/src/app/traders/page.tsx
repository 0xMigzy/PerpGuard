import { Suspense } from 'react';
import { TradersIndex } from './TradersIndex.tsx';

export const metadata = { title: 'Traders' };

export default function TradersPage() {
  // Suspense: the view reads the URL's search params on the client.
  return (
    <Suspense fallback={null}>
      <TradersIndex />
    </Suspense>
  );
}
