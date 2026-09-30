import Link from 'next/link';

export function Footer() {
  return (
    <footer className="wrap flex flex-wrap justify-between gap-3 border-t border-border pt-[18px] pb-6 text-[12px] text-muted">
      <span>Unofficial analytics. Not affiliated with or endorsed by Perpl or the Monad Foundation.</span>
      <span>
        <Link href="/data" className="text-muted hover:text-text">
          Data &amp; methodology
        </Link>
      </span>
    </footer>
  );
}
