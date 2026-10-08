import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import LinkLayout from '../../link/layout.tsx';

/** TEMPORARY test page (Stage 1 of wallet-signed key creation). Same Dynamic provider as /link. Not indexed, not linked. */
export const metadata: Metadata = { title: 'Key test', robots: { index: false, follow: false } };

export default function KeyTestLayout({ children }: { readonly children: ReactNode }) {
  return <LinkLayout>{children}</LinkLayout>;
}
