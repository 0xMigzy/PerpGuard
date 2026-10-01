/**
 * Navigation buttons: where a tap goes, never what it does to money.
 *
 * A SEPARATE NAMESPACE FROM ACTIONS, ON PURPOSE. Action buttons (`callback.ts`)
 * carry a token into the pending-action store and can, two taps later, reach
 * the executor. Navigation buttons carry a route and nothing else. The bot's
 * gate lets an UNLINKED chat through only with a payload that decodes HERE to
 * a route marked public, so the screens a watcher needs work for anyone while
 * every action payload, crafted or real, is still refused before a handler
 * runs. A route that is not public goes through the request-time link check
 * like any command.
 *
 * Encoded as `n1:<code>[:<id>]`: a version, a short code and at most one
 * integer. Strict both ways — the decoder rejects anything it did not write,
 * because a lenient one is how a crafted payload finds a route nobody built.
 */

export type Route =
  // ── public: anyone, linked or not ──
  | { readonly to: 'home' }
  | { readonly to: 'watch-ask' }
  /** Confirm a bare number pasted without being asked: is it an account id to watch? */
  | { readonly to: 'watch-id'; readonly accountId: number }
  | { readonly to: 'watchlist' }
  | { readonly to: 'wallet'; readonly accountId: number }
  | { readonly to: 'unwatch'; readonly accountId: number }
  | { readonly to: 'connect' }
  | { readonly to: 'connect-go' }
  // ── linked: resolved against the chat's link at tap time ──
  | { readonly to: 'positions' }
  | { readonly to: 'position'; readonly marketId: number }
  | { readonly to: 'settings' }
  | { readonly to: 'warn-ask' }
  | { readonly to: 'warn-set'; readonly level: number }
  | { readonly to: 'disconnect-ask' }
  | { readonly to: 'disconnect' }
  | { readonly to: 'kill-ask' }
  /** Fires the kill switch: the nonce must match the one kill-ask issued, once. */
  | { readonly to: 'kill-go'; readonly nonce: number };

type RouteName = Route['to'];

/** The codes on the wire. Short, because Telegram allows 64 bytes in all. */
const CODE: Readonly<Record<RouteName, string>> = {
  home: 'h',
  'watch-ask': 'wa',
  'watch-id': 'wi',
  watchlist: 'wl',
  wallet: 'w',
  unwatch: 'uw',
  connect: 'c',
  'connect-go': 'cg',
  positions: 'p',
  position: 'pd',
  settings: 's',
  'warn-ask': 'sw',
  'warn-set': 'sv',
  'disconnect-ask': 'dq',
  disconnect: 'dx',
  'kill-ask': 'kq',
  'kill-go': 'kx',
};
const NAME_BY_CODE = new Map<string, RouteName>(Object.entries(CODE).map(([name, code]) => [code, name as RouteName]));

/** Routes whose single argument is required, and what it is called. */
const ARG: Partial<Record<RouteName, 'accountId' | 'marketId' | 'level' | 'nonce'>> = {
  'kill-go': 'nonce',
  wallet: 'accountId',
  unwatch: 'accountId',
  'watch-id': 'accountId',
  position: 'marketId',
  'warn-set': 'level',
};

/**
 * THE PUBLIC SET. Everything a watcher can reach: the home screen, the watch
 * list and a watched wallet, stopping a watch (their own subscription in their
 * own chat), and the explanation of connecting. Nothing here touches an
 * account, a position or money.
 */
const PUBLIC: ReadonlySet<RouteName> = new Set<RouteName>(['home', 'watch-ask', 'watch-id', 'watchlist', 'wallet', 'unwatch', 'connect', 'connect-go']);

export function isPublicRoute(route: Route): boolean {
  return PUBLIC.has(route.to);
}

const VERSION = 'n1';

export function encodeNav(route: Route): string {
  const arg = ARG[route.to];
  const value = arg === undefined ? undefined : (route as unknown as Record<string, number>)[arg];
  if (arg !== undefined && (value === undefined || !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`route ${route.to} needs a non-negative integer ${arg}`);
  }
  const data = value === undefined ? `${VERSION}:${CODE[route.to]}` : `${VERSION}:${CODE[route.to]}:${value}`;
  if (new TextEncoder().encode(data).length > 64) throw new RangeError(`nav payload over 64 bytes: ${data}`);
  return data;
}

/** Read a tap back. Undefined for anything this file did not write. Never throws. */
export function decodeNav(data: string): Route | undefined {
  const parts = data.split(':');
  if (parts[0] !== VERSION || parts.length < 2 || parts.length > 3) return undefined;
  const name = NAME_BY_CODE.get(parts[1]!);
  if (name === undefined) return undefined;
  const arg = ARG[name];
  if (arg === undefined) return parts.length === 2 ? ({ to: name } as Route) : undefined;
  if (parts.length !== 3 || !/^\d{1,12}$/.test(parts[2]!)) return undefined;
  return { to: name, [arg]: Number(parts[2]) } as unknown as Route;
}
