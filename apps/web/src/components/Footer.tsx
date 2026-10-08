import Link from 'next/link';

/**
 * Every page's footer: where the data comes from, with the way to the Data &
 * Methodology page (/status), and that this is not Perpl's or Monad's site.
 * The unit (AUSD, a dollar stablecoin) is stated on /status, not here.
 */
export function Footer() {
  return (
    <footer className="wrap border-t border-border pt-[18px] pb-6 text-[12px] text-muted">
      <p className="m-0">
        Data sourced from Monad on-chain activity and Perpl exchange events ·{' '}
        <Link href="/status" className="text-text2 underline decoration-border2 underline-offset-2 hover:text-text">
          Data &amp; Methodology
        </Link>
      </p>
      <p className="m-0 mt-1">Unofficial analytics. Not affiliated with or endorsed by Perpl or the Monad Foundation.</p>
    </footer>
  );
}
