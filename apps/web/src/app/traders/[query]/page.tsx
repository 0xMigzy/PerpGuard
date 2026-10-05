import { TraderView } from './TraderView.tsx';

export const metadata = { title: 'Trader' };

export default async function TraderPage({ params }: { readonly params: Promise<{ query: string }> }) {
  const { query } = await params;
  // Opts every state of the profile (found, prefix search, not linked) into the terminal design system.
  return (
    <div data-ui="terminal">
      <TraderView query={decodeURIComponent(query)} />
    </div>
  );
}
