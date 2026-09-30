import { WalletView } from './WalletView.tsx';

export const metadata = { title: 'Wallet' };

export default async function WalletPage({ params }: { readonly params: Promise<{ query: string }> }) {
  const { query } = await params;
  return <WalletView query={decodeURIComponent(query)} />;
}
