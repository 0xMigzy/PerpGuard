import { ComingNext } from '@/components/ComingNext.tsx';

export const metadata = { title: 'Wallet' };

export default async function WalletPage({ params }: { readonly params: Promise<{ query: string }> }) {
  const { query } = await params;
  return <ComingNext title={`Wallet ${decodeURIComponent(query)}`} subtitle="Profile, open positions and round-trip history for this address or account id." />;
}
