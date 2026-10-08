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
import type { IndexerHealth, MarketRiskConfig, NetworkName } from '@perpguard/shared';
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
import { networkLabel, type ExecutionState } from './trading.ts';

export type Button =
  /** `fresh`: open as a new message rather than editing this one (see `NavTap`). */
  | { readonly text: string; readonly route: Route; readonly fresh?: boolean }
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
const BACK_TO_WATCH: Button = { text: '← Back', route: { to: 'watch-menu' } };

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

/** The linked account, as the menu shows it. */
export interface HomeAccount {
  readonly accountId: number;
  readonly network: NetworkName | undefined;
  readonly execution: ExecutionState;
  /** "8%": where the first warning comes. */
  readonly warnAt: string;
  /** The Automation line (HTML), when something runs or the kill switch is on. Undefined: None. */
  readonly automation?: string | undefined;
}

export interface HomeInput {
  readonly health: IndexerHealth | undefined;
  /** Accounts this chat watches. */
  readonly watching: number;
  /** The chat's linked account, if any. */
  readonly account: HomeAccount | undefined;
  /** The network a Trading Account would be on here, for "Not connected". */
  readonly tradingNetwork: NetworkName | undefined;
  /** Every position the chat can see: its own and the ones it watches. */
  readonly assessments: readonly RiskAssessment[];
  /** Rescue is built and wired, so a linked chat gets its button. */
  readonly rescue?: boolean;
  /** The Kill Switch is built and wired, so a linked chat gets its button. */
  readonly killSwitch?: boolean;
}

const TITLE = '🛡 <b>PERPGUARD</b>';

/**
 * Said only when the index is NOT serving current figures: the menu never
 * claims a freshness it does not have, and says nothing when all is well.
 */
export function indexLine(health: IndexerHealth | undefined): string | undefined {
  if (health === undefined || health.serveAsCurrent) return undefined;
  const behind = health.blocksBehind === undefined ? '' : `, ${health.blocksBehind.toLocaleString('en-US')} blocks behind`;
  return `⚠️ Index ${esc(health.state)}${behind}: watched figures may be late.`;
}

/** `🔗 testnet #24`: the network, said once. */
export const accountTag = (network: NetworkName | undefined, accountId: number): string => `🔗 ${network ?? 'testnet'} #${accountId}`;

/**
 * 🏠 THE MENU (owner, 8 Oct 2026). Nothing connected: what PerpGuard does and
 * how to start, two buttons. Connected: the account's state in four lines and
 * the six buttons. THE MENU SHOWS ONLY WHAT IS BUILT: a dead button is worse
 * than a missing one.
 */
export function homeScreen(input: HomeInput): Screen {
  const index = indexLine(input.health);
  const watching = input.watching === 0 ? undefined : `👁 Watching ${input.watching}`;

  if (input.account === undefined) {
    const lines = [
      TITLE,
      '',
      'I message you before a Perpl position gets liquidated.',
      '',
      'Send me any address or account number to start watching it — no key, nothing to set up.',
    ];
    if (watching !== undefined) lines.push('', watching);
    if (index !== undefined) lines.push('', index);
    return {
      html: lines.join('\n'),
      buttons: [[{ text: '👁 Watch & Alerts', route: { to: 'watch-menu' } }], [{ text: '🔐 Trading account', route: { to: 'account' } }]],
    };
  }

  const a = input.account;
  const lines = [
    TITLE,
    accountTag(a.network ?? input.tradingNetwork, a.accountId),
    `Execution: ${a.execution.dot} ${esc(a.execution.label)}`,
    `Automation: ${a.automation ?? '⚪ Off'}`,
    `Alerts: 🟢 ${a.warnAt} from liquidation`,
  ];
  if (watching !== undefined) lines.push(watching);
  if (index !== undefined) lines.push('', index);

  const buttons: Button[][] = [
    [
      { text: '👁 Watch & Alerts', route: { to: 'watch-menu' } },
      { text: '📊 My positions', route: { to: 'positions' } },
    ],
    [
      ...(input.rescue === true ? [{ text: '🛟 Rescue', route: { to: 'rescue' } } as Button] : []),
      { text: '🔐 Trading account', route: { to: 'account' } },
    ],
    [
      ...(input.killSwitch === true ? [{ text: '🆘 Kill switch', route: { to: 'kill' } } as Button] : []),
      { text: '⚙️ Settings', route: { to: 'settings' } },
    ],
  ];
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
  return { html: WATCH_PROMPT, buttons: [[{ text: '← Back', route: { to: 'wallets' } }]] };
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

/**
 * 👁 ONE WATCHED WALLET (owner, 8 Oct 2026): how many are open and the closest
 * one, and that there is nothing to press. The detail is on the website.
 */
export function walletScreen(input: WalletInput): Screen {
  const id = `#${input.accountId}`;
  const back: Button = { text: '← Back', route: input.back ?? { to: 'wallets' } };
  if (input.sub === undefined) {
    return { html: `You're not watching ${id} in this chat.`, buttons: [[{ text: `👛 Watch ${id}`, route: { to: 'watch-ask' } }], [back]] };
  }
  const lead = input.lead === undefined ? [] : [input.lead, ''];
  const stop: Button = { text: '🗑 Stop watching', route: { to: 'unwatch', accountId: input.accountId } };
  const head = `👁 <b>mainnet ${id}</b>`;
  const lines = [...lead];

  if (input.facts === undefined && input.assessments.length === 0) {
    lines.push(head, "I haven't read it yet. The first look takes up to 30 seconds — open it again in a moment.");
  } else if (input.facts?.found === false) {
    lines.push(head, 'Perpl has no record of this account yet.');
  } else {
    const open = input.facts?.openPositions ?? input.assessments.length;
    lines.push(`${head} · ${open} open`);
    const closest = closestOf(input.assessments);
    if (open === 0) lines.push("I'll message you if it opens a position and gets close to liquidation.");
    else if (closest !== undefined) lines.push(`Closest to liquidation: ${positionName(closest)}, ${closest.liqBufferPct !== undefined && closest.liqBufferPct < 0 ? 'past liquidation' : shortDistance(closest.liqBufferPct)}`);
    else if (input.assessments.some((a) => isBlind(a.state))) lines.push("I can't see its positions right now.");
  }
  lines.push('', NO_BUTTONS);
  return { html: lines.join('\n'), buttons: [[stop, back]] };
}

// ── the trading account ─────────────────────────────────────────────────────

export interface AccountScreenInput {
  /** Undefined: this chat has no linked account. */
  readonly accountId: number | undefined;
  readonly network: NetworkName | undefined;
  readonly execution: ExecutionState | undefined;
  /** When the account was connected to this chat. */
  readonly linkedAtMs?: number | undefined;
  /** Not linked, but a wallet proved this account: execution waits for a key. */
  readonly proven?: { readonly accountId: number; readonly walletAddress: string };
}

const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `8 Oct, 06:48` (UTC). */
export function shortWhen(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const CONNECT_BUTTONS: readonly (readonly Button[])[] = [
  [{ text: '🔗 Connect wallet', route: { to: 'connect-go' } }],
  [{ text: '🔑 Enter API key', route: { to: 'connect-key' } }],
  [BACK_HOME],
];

/**
 * 🔐 TRADING ACCOUNT (owner, 8 Oct 2026). Not connected: what connecting does
 * and the two ways in, both through the HTTPS page. Connected: the account,
 * its execution state and when it was connected. A key is never typed here.
 */
export function accountScreen(input: AccountScreenInput): Screen {
  if (input.accountId === undefined && input.proven !== undefined) {
    const p = input.proven;
    return {
      html: [
        '🔐 <b>TRADING ACCOUNT</b>',
        '',
        `Your wallet <code>${shortAddress(p.walletAddress)}</code> owns ${input.network ?? 'testnet'} #${p.accountId}.`,
        'To add margin for you I also need an API key for it. Enter it on the page, never here.',
      ].join('\n'),
      // A proof with no link is still something held for this person, so it can be undone from here.
      buttons: [[{ text: '🔑 Enter API key', route: { to: 'connect-key' } }], [{ text: `🔌 Disconnect #${p.accountId}`, route: { to: 'disconnect-ask' } }], [BACK_HOME]],
    };
  }
  if (input.accountId === undefined) {
    return {
      html: [
        '🔐 <b>TRADING ACCOUNT</b>',
        '',
        'No account connected.',
        '',
        'Connect your Perpl account and I can warn you before a position is liquidated, and add margin the moment you tap.',
        '',
        'A Perpl key can trade but can never withdraw or move your funds.',
      ].join('\n'),
      buttons: CONNECT_BUTTONS,
    };
  }
  const e = input.execution;
  const lines = [
    '🔐 <b>TRADING ACCOUNT</b>',
    accountTag(input.network, input.accountId),
    `Execution: ${e === undefined ? '⚪ Unknown' : `${e.dot} ${esc(e.label)}`}`,
  ];
  if (input.linkedAtMs !== undefined) lines.push(`Connected ${shortWhen(input.linkedAtMs)}`);
  if (e?.next !== undefined) lines.push('', esc(e.next));
  // A remedy that runs through the connect page gets its button; forwarding off does not (it needs the owner's wallet on Perpl).
  const fixable = e !== undefined && (e.dot === '🔴' || e.label === 'Not running');
  return {
    html: lines.join('\n'),
    buttons: [
      ...(fixable ? [[{ text: '🔑 Enter a new API key', route: { to: 'connect-key' } } as Button]] : []),
      [{ text: `🔌 Disconnect #${input.accountId}`, route: { to: 'disconnect-ask' } }],
      [BACK_HOME],
    ],
  };
}

/** The one-time page link, for the wallet or for a key. Nothing secret is ever typed here. */
export function connectGoScreen(url: string, minutes: number, via: 'wallet' | 'key'): Screen {
  return {
    html: [
      via === 'wallet' ? '🔗 <b>Connect wallet</b>' : '🔑 <b>Enter API key</b>',
      `Open this page — it works once, for ${minutes} minutes.`,
      via === 'wallet' ? 'Sign with the wallet that owns your Perpl account.' : 'Paste your key there. Never paste it here.',
      '',
      esc(url),
    ].join('\n'),
    buttons: [[{ text: '🔗 Open the page', url }], [{ text: '← Back', route: { to: 'account' } }]],
  };
}

/** A sentence when a link cannot be offered at all. */
export function connectUnavailableScreen(): Screen {
  return { html: "Connecting an account isn't available here. You can still watch any account.", buttons: [[{ text: '← Back', route: { to: 'account' } }]] };
}
