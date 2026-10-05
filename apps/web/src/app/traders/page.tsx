import { Suspense } from 'react';
import { TradersIndex } from './TradersIndex.tsx';

export const metadata = { title: 'Traders' };

export default function TradersPage() {
  // Suspense: the view reads the URL's search params on the client.
  return (
    // Opts this page into the terminal design system (globals.css).
    <div data-ui="terminal">
      <Suspense fallback={null}>
        <TradersIndex />
      </Suspense>
    </div>
  );
}
