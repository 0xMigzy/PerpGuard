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
  /** 👁 Watch & Alerts: the read-only half's own menu. */
  | { readonly to: 'watch-menu' }
  | { readonly to: 'watch-ask' }
  /** Confirm a bare number pasted without being asked: is it an account id to watch? */
  | { readonly to: 'watch-id'; readonly accountId: number }
  | { readonly to: 'watchlist' }
  /** 👛 Every wallet this chat watches. */
  | { readonly to: 'wallets' }
  /** ⭐ Put a watched wallet on, or take it off, the Watchlist. */
  | { readonly to: 'star'; readonly accountId: number }
  | { readonly to: 'unstar'; readonly accountId: number }
  /** 🏆 Top Traders: Top PnL (30 days) and Top ROI (all time), and one trader's card. */
  | { readonly to: 'top' }
  | { readonly to: 'top-pnl' }
  | { readonly to: 'top-roi' }
  | { readonly to: 'trader'; readonly accountId: number }
  /** 🔁 What if I'd copied this trader for 30 days? A replay from the index; sends nothing. */
  | { readonly to: 'copy-sim'; readonly accountId: number }
  | { readonly to: 'copy-sim7'; readonly accountId: number }
  /** 🔁 Copy Trading, live (Half B). LINKED ONLY: each resolves the chat's link at tap time. */
  | { readonly to: 'copy-setup'; readonly accountId: number }
  | { readonly to: 'copy-keep'; readonly level: number }
  | { readonly to: 'copy-start' }
  | { readonly to: 'copy-status' }
  | { readonly to: 'copy-stop' }
  | { readonly to: 'copy-resume' }
  | { readonly to: 'copy-keep-set'; readonly level: number }
  /** 💥 / 🐋 The feeds' thresholds: `level` is the preset's index, or OFF_LEVEL. */
  | { readonly to: 'liq' }
  | { readonly to: 'liq-set'; readonly level: number }
  | { readonly to: 'big' }
  | { readonly to: 'big-set'; readonly level: number }
  /** ⚠️ Warning levels for watched wallets: a preset by index, OFF_LEVEL, or typed. */
  | { readonly to: 'warn-levels' }
  | { readonly to: 'warn-preset'; readonly level: number }
  | { readonly to: 'warn-custom' }
  /** ⚙️ Alert Settings, and the wallet-alerts switch. */
  | { readonly to: 'alert-settings' }
  | { readonly to: 'wallet-alerts' }
  | { readonly to: 'wallet'; readonly accountId: number }
  | { readonly to: 'unwatch'; readonly accountId: number }
  /** 🔐 Trading Account. Public: an unlinked chat sees "Not connected" and how to connect. */
  | { readonly to: 'account' }
  /** Kept so a "Connect my account" button already sitting in a chat still opens; shows the Trading Account. */
  | { readonly to: 'connect' }
  | { readonly to: 'connect-go' }
  // ── linked: resolved against the chat's link at tap time ──
  | { readonly to: 'positions' }
  /** 💰 Margin: the positions, framed for adding margin. Each still goes through the position screen's confirm. */
  | { readonly to: 'margin' }
  /** 💰 One position's margin (spec 33), and its Add Margin amounts (spec 34). Linked only. */
  | { readonly to: 'margin-pos'; readonly marketId: number }
  | { readonly to: 'margin-add'; readonly marketId: number }
  | { readonly to: 'position'; readonly marketId: number }
  /** 🛟 Liquidation Rescue (spec 38-42). Linked only; the rule is re-validated server-side on enable. */
  | { readonly to: 'rescue' }
  | { readonly to: 'rescue-pos'; readonly marketId: number }
  | { readonly to: 'rescue-cfg'; readonly marketId: number }
  | { readonly to: 'rescue-trig'; readonly level: number }
  | { readonly to: 'rescue-trig-custom' }
  | { readonly to: 'rescue-amt'; readonly level: number }
  | { readonly to: 'rescue-amt-custom' }
  | { readonly to: 'rescue-review' }
  | { readonly to: 'rescue-limit'; readonly level: number }
  | { readonly to: 'rescue-lim'; readonly level: number }
  | { readonly to: 'rescue-on' }
  /** Turn Auto on for a position already inside the line, acting only from the next crossing. */
  | { readonly to: 'rescue-on-next' }
  | { readonly to: 'rescue-stop'; readonly marketId: number }
  | { readonly to: 'rescue-resume'; readonly marketId: number }
  /**
   * 🔴 Kill Switch (Phase 20, spec 56-57): stop automation, leave positions
   * open. NEW codes: the retired close-all's `kq`/`kx` stay dead forever, so an
   * old button can never be read as the new meaning.
   */
  | { readonly to: 'kill' }
  | { readonly to: 'kill-confirm' }
  | { readonly to: 'kill-stop' }
  | { readonly to: 'kill-resume-ask' }
  | { readonly to: 'kill-resume' }
  /** 🚪 Close everything (owner, 7 Oct 2026): the list, then a TYPED "CLOSE ALL". Retry is per position. */
  | { readonly to: 'close-all' }
  | { readonly to: 'close-retry'; readonly marketId: number }
  | { readonly to: 'close-retry-go'; readonly marketId: number }
  | { readonly to: 'settings' }
  | { readonly to: 'warn-ask' }
  | { readonly to: 'warn-set'; readonly level: number }
  /** 🔔 A custom alert distance, typed. */
  | { readonly to: 'alert-custom' }
  /** 🔔 Dismiss a manual alert: its buttons go, its words stay, nothing is sent. */
  | { readonly to: 'dismiss' }
  | { readonly to: 'disconnect-ask' }
  | { readonly to: 'disconnect' };
// The close-all kill switch ('kq', 'kx') is RETIRED (6 Oct 2026): Close All is
// cut and the kill switch returns in Phase 20 as "stop automation". Its codes
// decode to nothing, so an old button in a chat fires nothing; see `isNavShaped`.

type RouteName = Route['to'];

/** The codes on the wire. Short, because Telegram allows 64 bytes in all. */
const CODE: Readonly<Record<RouteName, string>> = {
  home: 'h',
  'watch-menu': 'wm',
  'watch-ask': 'wa',
  'watch-id': 'wi',
  watchlist: 'wl',
  wallets: 'ws',
  star: 'st',
  unstar: 'us',
  top: 'tt',
  'top-pnl': 'tp',
  'top-roi': 'tr',
  trader: 'tc',
  'copy-sim': 'cs',
  'copy-sim7': 'cs7',
  'copy-setup': 'cpu',
  'copy-keep': 'cpk',
  'copy-start': 'cpg',
  'copy-status': 'cps',
  'copy-stop': 'cpx',
  'copy-resume': 'cpr',
  'copy-keep-set': 'cpf',
  liq: 'lq',
  'liq-set': 'lqs',
  big: 'lt',
  'big-set': 'lts',
  'warn-levels': 'wv',
  'warn-preset': 'wp',
  'warn-custom': 'wc',
  'alert-settings': 'as',
  'wallet-alerts': 'wt',
  wallet: 'w',
  unwatch: 'uw',
  account: 'ta',
  connect: 'c',
  'connect-go': 'cg',
  positions: 'p',
  margin: 'mg',
  'margin-pos': 'mp',
  'margin-add': 'ma',
  position: 'pd',
  rescue: 'r',
  'rescue-pos': 'rp',
  'rescue-cfg': 'rc',
  'rescue-trig': 'rt',
  'rescue-trig-custom': 'rtc',
  'rescue-amt': 'ra',
  'rescue-amt-custom': 'rac',
  'rescue-review': 'rr',
  'rescue-limit': 'rl',
  'rescue-lim': 'rlv',
  'rescue-on': 'ro',
  'rescue-on-next': 'ron',
  'rescue-stop': 'rs',
  'rescue-resume': 'rv',
  kill: 'ks',
  'kill-confirm': 'ksc',
  'kill-stop': 'ksx',
  'kill-resume-ask': 'ksr',
  'kill-resume': 'ksv',
  'close-all': 'xa',
  'close-retry': 'xr',
  'close-retry-go': 'xg',
  settings: 's',
  'warn-ask': 'sw',
  'warn-set': 'sv',
  'alert-custom': 'acu',
  dismiss: 'dm',
  'disconnect-ask': 'dq',
  disconnect: 'dx',
};
const NAME_BY_CODE = new Map<string, RouteName>(Object.entries(CODE).map(([name, code]) => [code, name as RouteName]));

/** Routes whose single argument is required, and what it is called. */
const ARG: Partial<Record<RouteName, 'accountId' | 'marketId' | 'level'>> = {
  wallet: 'accountId',
  star: 'accountId',
  unstar: 'accountId',
  trader: 'accountId',
  'copy-sim': 'accountId',
  'copy-sim7': 'accountId',
  'copy-setup': 'accountId',
  'copy-keep': 'level',
  'copy-keep-set': 'level',
  'liq-set': 'level',
  'big-set': 'level',
  'warn-preset': 'level',
  unwatch: 'accountId',
  'watch-id': 'accountId',
  position: 'marketId',
  'margin-pos': 'marketId',
  'margin-add': 'marketId',
  'warn-set': 'level',
  'rescue-pos': 'marketId',
  'rescue-cfg': 'marketId',
  'rescue-trig': 'level',
  'rescue-amt': 'level',
  'rescue-limit': 'level',
  'rescue-lim': 'level',
  'rescue-stop': 'marketId',
  'rescue-resume': 'marketId',
  'close-retry': 'marketId',
  'close-retry-go': 'marketId',
};

/**
 * THE PUBLIC SET. Everything a watcher can reach: the home screen, the Watch
 * & Alerts menu, the watch list and a watched wallet, stopping a watch (their
 * own subscription in their own chat), and the Trading Account screen, which
 * for an unlinked chat says "Not connected" and how to connect. Nothing here touches an
 * account, a position or money.
 */
const PUBLIC: ReadonlySet<RouteName> = new Set<RouteName>([
  'home', 'watch-menu', 'watch-ask', 'watch-id', 'watchlist', 'wallet', 'unwatch', 'account', 'connect', 'connect-go',
  // Phase 8: read the index, or change this chat's OWN alert settings. Nothing touches an account.
  'wallets', 'star', 'unstar', 'top', 'top-pnl', 'top-roi', 'trader', 'copy-sim', 'copy-sim7', 'liq', 'liq-set', 'big', 'big-set',
  'warn-levels', 'warn-preset', 'warn-custom', 'alert-settings', 'wallet-alerts',
]);

/** The `level` that means Off on the threshold and warning routes. */
export const OFF_LEVEL = 9;

export function isPublicRoute(route: Route): boolean {
  return PUBLIC.has(route.to);
}

const VERSION = 'n1';

/**
 * A tap that opens its screen as a NEW message instead of editing the one it
 * sits on. Used on outcome reports: those are the record of
 * what happened to someone's money, and navigating on from one must not
 * overwrite it. Encoded as a trailing `+` on the code.
 */
export interface NavTap {
  readonly route: Route;
  readonly fresh: boolean;
}

export function encodeNav(route: Route, options: { readonly fresh?: boolean } = {}): string {
  if (options.fresh === true) {
    const plain = encodeNav(route);
    const [v, code, ...rest] = plain.split(':');
    return [v, `${code}+`, ...rest].join(':');
  }
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
  return decodeNavTap(data)?.route;
}

/** A tap with its `fresh` flag. */
export function decodeNavTap(data: string): NavTap | undefined {
  const parts = data.split(':');
  const fresh = parts[1]?.endsWith('+') === true;
  if (fresh) parts[1] = parts[1]!.slice(0, -1);
  const route = decodeParts(parts);
  return route === undefined ? undefined : { route, fresh };
}

function decodeParts(parts: string[]): Route | undefined {
  if (parts[0] !== VERSION || parts.length < 2 || parts.length > 3) return undefined;
  const name = NAME_BY_CODE.get(parts[1]!);
  if (name === undefined) return undefined;
  const arg = ARG[name];
  if (arg === undefined) return parts.length === 2 ? ({ to: name } as Route) : undefined;
  if (parts.length !== 3 || !/^\d{1,12}$/.test(parts[2]!)) return undefined;
  return { to: name, [arg]: Number(parts[2]) } as unknown as Route;
}

/**
 * A payload in this namespace that no longer decodes: a button from an older
 * menu (the retired kill switch, say). The bot answers it as such and runs
 * nothing, rather than reporting it as unreadable.
 */
export function isNavShaped(data: string): boolean {
  return data.startsWith(`${VERSION}:`);
}
