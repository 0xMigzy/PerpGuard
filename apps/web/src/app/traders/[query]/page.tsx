import { TraderView } from './TraderView.tsx';

export const metadata = { title: 'Trader' };

export default async function TraderPage({ params }: { readonly params: Promise<{ query: string }> }) {
  const { query } = await params;
  return <TraderView query={decodeURIComponent(query)} />;
}
