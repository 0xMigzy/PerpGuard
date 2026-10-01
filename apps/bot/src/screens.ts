/**
 * The bot's screens, as pure functions: data in, Telegram HTML and a button
 * layout out. The layout follows `docs/bot-screens.html`; the words follow the
 * plain-voice rules in `@perpguard/backend/alerts/plain`, which this file uses
 * for every amount, distance and position name so a screen and an alert can
 * never word the same position two ways.
 *
 * NO SCREEN A WATCHER CAN REACH HAS AN ACTION BUTTON. Every button here is a
 * navigation route or a URL. The account half's action buttons are built
 * elsewhere, on screens that only resolve for a linked chat.
 */
import type { IndexerHealth, MarketRiskConfig } from '@perpguard/shared';
import {
  DISTANCE_EXPLAINED,
  NO_BUTTONS,
  distance,
  esc,
  freeVerdict,
  freshness,
  held,
  positionName,
  shortDistance,
  watchedPositionLines,
} from '@perpguard/backend/alerts/plain';
import { isBlind, type RiskAssessment } from '@perpguard/backend/risk';
import type { Route } from './nav.ts';
import type { WatchSubscription } from './watch.ts';

export type Button =
  | { readonly text: string; readonly route: Route }
  | { readonly text: string; readonly url: string }
  /**
   * An ACTION button: pre-encoded `callback.ts` data carrying a pending-action
   * token. Only the account screens build these, and only for a linked chat;
   * the gate refuses every one of them from anyone else.
   */
  | { readonly text: string; readonly data: string };

export interface Screen {
  /** Telegram HTML. */
  readonly html: string;
  readonly buttons: readonly (readonly Button[])[];
}

/** What the last watch pass knew about one account. Mirrors the loop's facts. */
export interface AccountFacts {
  readonly found: boolean;
  readonly openPositions: number;
  readonly unassessable: number;
}

const BACK_HOME: Button = { text: '← Back', route: { to: 'home' } };

/** Positions listed on one wallet screen, closest first; the rest are counted. */
export const WALLET_MAX_POSITIONS = 5;

// ── the header ──────────────────────────────────────────────────────────────

/**
 * "live from Monad" ONLY when the index is serving current figures. A header
 * that always said live would be the one place the bot claimed a freshness
 * it does not have.
 */
export function headerLine(health: IndexerHealth | undefined): string {
  if (health === undefined) return '<b>PerpGuard</b> · on Monad';
  if (health.serveAsCurrent) return '<b>PerpGuard</b> · live from Monad';
  const behind = health.blocksBehind === undefined ? '' : `, ${health.blocksBehind.toLocaleString('en-US')} blocks behind`;
  return `<b>PerpGuard</b> · Monad, index ${esc(health.state)}${behind}`;
}

// ── home ────────────────────────────────────────────────────────────────────

export interface HomeInput {
  readonly health: IndexerHealth | undefined;
  /** Accounts this chat watches. */
  readonly watching: number;
  /** The chat's linked account, if any. */
  readonly linkedAccountId: number | undefined;
  /** Every position the chat can see: its own and the ones it watches. */
  readonly assessments: readonly RiskAssessment[];
  /** The public web app, for the "Open PerpGuard" button. */
  readonly webUrl: string | undefined;
}

export function homeScreen(input: HomeInput): Screen {
  const open: Button[] = input.webUrl === undefined ? [] : [{ text: '📊 Open PerpGuard', url: input.webUrl }];
  const firstRun = input.watching === 0 && input.linkedAccountId === undefined;

  if (firstRun) {
    return {
      html: [
        headerLine(input.health),
        'Watch any Perpl trader and get told before they are liquidated.',
        'Connect your own account and you can act on it.',
        '',
        '👁 Not watching anything yet',
        '🛡 No account connected',
      ].join('\n'),
      buttons: [
        [{ text: '👁 Watch a wallet', route: { to: 'watch-ask' } }],
        [{ text: '🔗 Connect my account', route: { to: 'connect' } }],
        ...(open.length === 0 ? [] : [open]),
      ],
    };
  }

  const lines = [headerLine(input.health), ''];
  lines.push(input.watching === 0 ? '👁 Not watching anything yet' : `👁 Watching <b>${input.watching} wallet${input.watching === 1 ? '' : 's'}</b>`);
  lines.push(input.linkedAccountId === undefined ? '🛡 No account connected' : `🛡 My account <b>#${input.linkedAccountId}</b>`);
  const closest = closestOf(input.assessments);
  if (closest !== undefined) lines.push(`Closest to liquidation <b>${shortDistance(closest.liqBufferPct)}</b>`);

  const buttons: Button[][] = [
    [
      { text: '👁 Watch a wallet', route: { to: 'watch-ask' } },
      { text: '📋 My watchlist', route: { to: 'watchlist' } },
    ],
    input.linkedAccountId === undefined
      ? [{ text: '🔗 Connect my account', route: { to: 'connect' } }]
      : [
          { text: '🛡 My positions', route: { to: 'positions' } },
          { text: '⚙️ Settings', route: { to: 'settings' } },
        ],
  ];
  if (open.length > 0) buttons.push(open);
  return { html: lines.join('\n'), buttons };
}

/** The position nearest its closing price among those that can be priced. */
export function closestOf(assessments: readonly RiskAssessment[]): RiskAssessment | undefined {
  let best: RiskAssessment | undefined;
  for (const a of assessments) {
    if (isBlind(a.state) || a.liqBufferPct === undefined) continue;
    if (best === undefined || a.liqBufferPct < (best.liqBufferPct as number)) best = a;
  }
  return best;
}

// ── asking what to watch ────────────────────────────────────────────────────

export const WATCH_PROMPT = 'Send me an address or an account id.\nEither works. You can paste one any time without pressing anything first.';
export const WATCH_PLACEHOLDER = '0x… or 710';

export function watchAskScreen(): Screen {
  return { html: WATCH_PROMPT, buttons: [[BACK_HOME]] };
}

// ── the watch list ──────────────────────────────────────────────────────────

export interface WatchlistRow {
  readonly sub: WatchSubscription;
  readonly assessments: readonly RiskAssessment[];
  readonly facts: AccountFacts | undefined;
}

/** One line of the list: what is open, and how close the closest is. */
export function watchlistLine(row: WatchlistRow): string {
  const id = `#${row.sub.accountId}`;
  if (row.facts === undefined) return `${id} · checking…`;
  if (!row.facts.found) return `${id} · not in the index`;
  if (row.facts.openPositions === 0) return `${id} · no open positions`;
  const priced = row.assessments.filter((a) => !isBlind(a.state));
  if (priced.length === 0) {
    return row.assessments.length > 0
      ? `${id} · can't see right now`
      : `${id} · ${row.facts.openPositions} position${row.facts.openPositions === 1 ? '' : 's'}, not priceable`;
  }
  const closest = closestOf(priced);
  const what = row.facts.openPositions === 1 && row.assessments.length === 1 ? positionName(row.assessments[0]!) : `${row.facts.openPositions} positions`;
  return `${id} · ${what} · <b>${shortDistance(closest?.liqBufferPct)}</b>`;
}

export function watchlistScreen(rows: readonly WatchlistRow[], maxPerChat: number): Screen {
  if (rows.length === 0) {
    return {
      html: '<b>My watchlist</b>\nYou are not watching anything yet. Watch any Perpl account by its address or account id — no wallet needed.',
      buttons: [[{ text: '👁 Watch a wallet', route: { to: 'watch-ask' } }], [BACK_HOME]],
    };
  }
  const html = [
    `<b>Watching ${rows.length} wallet${rows.length === 1 ? '' : 's'}</b> · ${rows.length} of ${maxPerChat}`,
    '',
    ...rows.map(watchlistLine),
    '',
    `<i>${DISTANCE_EXPLAINED}</i>`,
  ].join('\n');
  const wallets: Button[][] = [];
  for (let i = 0; i < rows.length; i += 3) {
    wallets.push(rows.slice(i, i + 3).map((row) => ({ text: `#${row.sub.accountId}`, route: { to: 'wallet', accountId: row.sub.accountId } }) as Button));
  }
  const more: Button[] = rows.length < maxPerChat ? [{ text: '👁 Watch another', route: { to: 'watch-ask' } }] : [];
  return { html, buttons: [...wallets, ...(more.length === 0 ? [] : [more]), [BACK_HOME]] };
}

// ── one watched wallet ──────────────────────────────────────────────────────

export interface WalletInput {
  readonly accountId: number;
  readonly sub: WatchSubscription | undefined;
  readonly assessments: readonly RiskAssessment[];
  readonly facts: AccountFacts | undefined;
  readonly configs: ReadonlyMap<number, MarketRiskConfig> | undefined;
  /** A line to put above everything, e.g. "Now watching #3388." */
  readonly lead?: string;
  /** Where Back goes: the list, or home after a fresh watch. */
  readonly back?: Route;
}

export function walletScreen(input: WalletInput): Screen {
  const id = `#${input.accountId}`;
  const back: Button = { text: '← Back', route: input.back ?? { to: 'watchlist' } };
  if (input.sub === undefined) {
    return { html: `You are not watching ${id} in this chat.`, buttons: [[{ text: `👁 Watch ${id}`, route: { to: 'watch-ask' } }], [back]] };
  }
  const lead = input.lead === undefined ? [] : [input.lead, ''];
  const stop: Button = { text: '🔕 Stop watching', route: { to: 'unwatch', accountId: input.accountId } };

  if (input.facts === undefined && input.assessments.length === 0) {
    return {
      html: [...lead, `<b>Account ${id}</b>`, 'I have not read it from the index yet. The first look takes up to half a minute; open it again in a moment.', '', NO_BUTTONS].join('\n'),
      buttons: [[stop, back]],
    };
  }
  if (input.facts?.found === false) {
    return { html: [...lead, `<b>Account ${id}</b>`, 'The index holds nothing for this account yet.', '', NO_BUTTONS].join('\n'), buttons: [[stop, back]] };
  }
  if ((input.facts?.openPositions ?? input.assessments.length) === 0) {
    return {
      html: [...lead, `<b>Account ${id}</b> · no open positions`, 'I will message this chat when it opens one and it gets close to being closed.', '', NO_BUTTONS].join('\n'),
      buttons: [[stop, back]],
    };
  }

  // Closest first; blind ones (no buffer) first of all, because not knowing is the worst.
  const ordered = [...input.assessments].sort((a, b) => (a.liqBufferPct ?? -Infinity) - (b.liqBufferPct ?? -Infinity));
  const closest = closestOf(ordered);
  const title = closest === undefined ? `<b>Account ${id}</b>` : `<b>Account ${id}</b> · ${distance(closest.liqBufferPct)}`;
  const lines = [...lead, title];
  // BOUNDED: Telegram refuses a message over 4,096 characters, and an account
  // with dozens of positions would lose the whole screen to that.
  const shown = ordered.slice(0, WALLET_MAX_POSITIONS);
  for (const a of shown) {
    lines.push('', ...watchedPositionLines(a, input.configs?.get(a.marketId)));
  }
  const rest = ordered.length - shown.length;
  if (rest > 0) lines.push('', `And ${rest} more position${rest === 1 ? '' : 's'}, all further from being closed.`);
  const hidden = (input.facts?.unassessable ?? 0);
  if (hidden > 0) lines.push('', `${hidden} more position${hidden === 1 ? '' : 's'} I cannot price: opened before the index starts, or on a market the venue does not list.`);

  const scope = ordered[0]?.watch;
  lines.push('');
  if (scope?.freeBalanceCNS !== undefined) lines.push(`They hold free ${held(scope.freeBalanceCNS)}`);
  lines.push(freeVerdict(scope, ordered.filter((a) => !isBlind(a.state))));
  if (scope !== undefined && ordered[0] !== undefined) lines.push(freshness(scope, ordered[0]));
  lines.push('', NO_BUTTONS);
  return { html: lines.join('\n'), buttons: [[stop, back]] };
}

// ── connecting ──────────────────────────────────────────────────────────────

/** Explained before it is offered: what PerpGuard can and cannot do with it. */
export function connectScreen(linkedAccountId: number | undefined): Screen {
  if (linkedAccountId !== undefined) {
    return {
      html: `<b>Your account is connected</b>\nThis chat is connected to account <b>#${linkedAccountId}</b>. Disconnect it from Settings.`,
      buttons: [[{ text: '⚙️ Settings', route: { to: 'settings' } }], [BACK_HOME]],
    };
  }
  return {
    html: [
      '<b>Connecting your account</b>',
      'With your approval each time, PerpGuard can add margin to a position, reduce it, or close it.',
      '',
      'It can never withdraw or transfer your funds. A Perpl API key has no permission to move money out, and you can disconnect at any time.',
    ].join('\n'),
    buttons: [[{ text: '🔗 Connect', route: { to: 'connect-go' } }], [BACK_HOME]],
  };
}

/** The one-time page link. The proof happens there; nothing secret is ever typed here. */
export function connectGoScreen(url: string, minutes: number): Screen {
  return {
    html: [
      '<b>Prove the account is yours</b>',
      `Open the page below. It works once, for ${minutes} minutes, and proves nothing by itself: there you sign with the wallet that owns the account, or paste an API key for it.`,
      '',
      'Never paste a key here in Telegram — only on that page.',
      '',
      esc(url),
    ].join('\n'),
    buttons: [[{ text: '🔗 Open the connect page', url }], [BACK_HOME]],
  };
}

/** A sentence when a link cannot be offered at all. */
export function connectUnavailableScreen(): Screen {
  return { html: 'Connecting an account is not available on this deployment. You can still watch any account.', buttons: [[BACK_HOME]] };
}
