import { Suspense } from 'react';
import { CompareView } from './CompareView.tsx';

export const metadata = { title: 'Compare' };

export default function ComparePage() {
  // Suspense: the view reads the accounts from the URL's search params on the client.
  return (
    // Opts this page into the terminal design system (globals.css).
    <div data-ui="terminal">
      <Suspense fallback={null}>
        <CompareView />
      </Suspense>
    </div>
  );
}
