/*
 * The "Data & methodology" section was taken off the site on 4 Oct 2026 at the
 * owner's request, to come back later. Its text is in git (this file at 11e3eec)
 * and its facts in src/lib/methodology.ts; the detail stays in docs/methodology.md.
 */
export function Footer() {
  return (
    <footer className="wrap border-t border-border pt-[18px] pb-6 text-[12px] text-muted">
      <div className="flex flex-wrap justify-between gap-3">
        <span>Unofficial analytics. Not affiliated with or endorsed by Perpl or the Monad Foundation.</span>
        <span>Every figure is derived from indexed exchange events. Amounts in AUSD, a dollar stablecoin. Read-only: nothing here can act on an account.</span>
      </div>
    </footer>
  );
}
