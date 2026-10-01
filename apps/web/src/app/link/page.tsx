import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LinkView } from './LinkView.tsx';

export const metadata: Metadata = {
  title: 'Link your account',
  description: 'Prove you own a Perpl account so the PerpGuard bot can act on it from your chat.',
  robots: { index: false, follow: false },
};

export default function LinkPage() {
  return (
    <Suspense fallback={null}>
      <LinkView />
    </Suspense>
  );
}
