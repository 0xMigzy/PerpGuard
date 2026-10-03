import { tokenIcon, tokenInitials } from '@/lib/tokens.ts';

/**
 * A market's token icon, or a neutral circle with its initials: same size, same
 * shape, so the fallback reads as deliberate. DECORATIVE: hidden from screen
 * readers, which get the market name beside it.
 */
export function TokenIcon({ symbol, size = 20 }: { readonly symbol: string; readonly size?: number }) {
  const src = tokenIcon(symbol);
  const box = { width: size, height: size };
  if (src !== undefined) {
    // A plain img: these are tiny static files, and next/image would add a loader for nothing.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" aria-hidden="true" width={size} height={size} className="inline-block flex-none rounded-full object-cover align-middle" style={box} />;
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex flex-none items-center justify-center rounded-full border border-border2 bg-card2 align-middle font-semibold text-muted"
      style={{ ...box, fontSize: Math.round(size * 0.4) }}
    >
      {tokenInitials(symbol)}
    </span>
  );
}

/** The icon and the name on one line, text alignment unchanged. */
export function MarketName({ symbol, size }: { readonly symbol: string; readonly size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 align-middle">
      <TokenIcon symbol={symbol} {...(size === undefined ? {} : { size })} />
      <span>{symbol}</span>
    </span>
  );
}
