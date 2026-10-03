/**
 * Token icons, vendored under public/tokens. Sources, licences and the reason
 * any market is on the fallback: public/tokens/SOURCES.md.
 *
 * Keyed by the market's TICKER (the context's for a live market, the chain's for
 * one not yet trading). A ticker missing here is drawn as the fallback circle.
 */
export const TOKEN_ICONS: Readonly<Record<string, string>> = {
  BTC: '/tokens/btc.svg',
  ETH: '/tokens/eth.svg',
  SOL: '/tokens/sol.svg',
  ZEC: '/tokens/zec.svg',
  UNI: '/tokens/uni.svg',
  AAVE: '/tokens/aave.svg',
  MON: '/tokens/mon.png',
  HYPE: '/tokens/hype.png',
  NEAR: '/tokens/near.png',
  ARB: '/tokens/arb.png',
  ENA: '/tokens/ena.png',
  MORPHO: '/tokens/morpho.png',
  PUMP: '/tokens/pump.png',
  VVV: '/tokens/vvv.png',
};

export function tokenIcon(symbol: string): string | undefined {
  return TOKEN_ICONS[symbol.toUpperCase()];
}

/** The fallback's text: the first two letters, so LIT and LINK never collide on one. */
export function tokenInitials(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
}
