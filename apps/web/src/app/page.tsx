import { Suspense } from 'react';
import { OverviewView } from './OverviewView.tsx';

export default function OverviewPage() {
  // Suspense: the view reads the URL's search params on the client.
  return (
    <Suspense fallback={null}>
      <OverviewView />
    </Suspense>
  );
}
