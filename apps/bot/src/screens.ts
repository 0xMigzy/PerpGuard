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
  /** The public web app, for the "Open PerpGuard" button. */
  readonly webUrl: string | undefined;
  /** Rescue is built and wired, so a linked chat gets its button. */
  readonly rescue?: boolean;
  /** The Kill Switch is built and wired, so a linked chat gets its button. */
  readonly killSwitch?: boolean;
}

const TITLE = '🛡 <b>PERPGUARD</b>\nAnalyse. Watch. Act.';

/**
 * Said only when the index is NOT serving current figures: the menu never
 * claims a freshness it does not have, and says nothing when all is well.
 */
export function indexLine(health: IndexerHealth | undefined): string | undefined {
  if (health === undefined || health.serveAsCurrent) return undefined;
  const behind = health.blocksBehind === undefined ? '' : `, ${health.blocksBehind.toLocaleString('en-US')} blocks behind`;
  return `⚠️ Index ${esc(health.state)}${behind}: watched figures may be late.`;
}

/**
 * THE MENU SHOWS ONLY WHAT IS BUILT. Rescue, Copy Trading and the Kill Switch
 * are not on it until their phase lands: a dead button is worse than a
 * missing one, and the close-all kill switch it used to carry is retired.
 */
export function homeScreen(input: HomeInput): Screen {
  const open: Button[] = input.webUrl === undefined ? [] : [{ text: '🌐 Open PerpGuard', url: input.webUrl }];
  const index = indexLine(input.health);
  const watchingLine = input.watching === 0 ? undefined : `👁 Watching <b>${input.watching} wallet${input.watching === 1 ? '' : 's'}</b>`;

  if (input.account === undefined) {
    const firstRun = input.watching === 0;
    const lines = firstRun
      ? [
          TITLE,
          '',
          'Real-time Perpl intelligence and risk protection on Monad.',
          '',
          '👁 <b>WATCH</b>\nTrack any trader and get told before a position is closed.',
          '',
          '🛟 <b>PROTECT</b>\nConnect your own account to add margin, reduce or close, each time only after you confirm.',
        ]
      : [TITLE, '', `🔐 Trading Account: <b>Not connected</b>`, watchingLine!];
    if (index !== undefined) lines.push('', index);
    return {
      html: lines.join('\n'),
      buttons: [[{ text: '👁 Watch & Alerts', route: { to: 'watch-menu' } }], [{ text: '🔐 Trading Account', route: { to: 'account' } }], ...(open.length === 0 ? [] : [open])],
    };
  }

  const a = input.account;
  const lines = [
    TITLE,
    '',
    `🔐 Trading Account: <b>#${a.accountId}</b> · ${networkLabel(a.network)}`,
    `Execution: ${a.execution.dot} ${esc(a.execution.label)}`,
    `Automation: ${a.automation ?? '⚪ None'}`,
    `Alerts: 🟢 ON · first warning at ${a.warnAt}`,
  ];
  if (watchingLine !== undefined) lines.push(watchingLine);
  const closest = closestOf(input.assessments);
  if (closest !== undefined) lines.push(`Closest to liquidation <b>${shortDistance(closest.liqBufferPct)}</b>`);
  if (index !== undefined) lines.push('', index);

  const buttons: Button[][] = [
    [
      { text: '👁 Watch & Alerts', route: { to: 'watch-menu' } },
      { text: '📊 My Positions', route: { to: 'positions' } },
    ],
    // Spec 20's grid, with what is built: Rescue beside Margin, the Kill Switch beside the Trading Account.
    input.rescue === true
      ? [
          { text: '🛟 Rescue', route: { to: 'rescue' } },
          { text: '💰 Margin', route: { to: 'margin' } },
        ]
      : [{ text: '💰 Margin', route: { to: 'margin' } }],
    input.killSwitch === true
      ? [
          { text: '🔴 Kill Switch', route: { to: 'kill' } },
          { text: '🔐 Trading Account', route: { to: 'account' } },
        ]
      : [{ text: '🔐 Trading Account', route: { to: 'account' } }],
    [{ text: '⚙️ Settings', route: { to: 'settings' } }],
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

export function walletScreen(input: WalletInput): Screen {
  const id = `#${input.accountId}`;
  const back: Button = { text: '← Back', route: input.back ?? { to: 'wallets' } };
  if (input.sub === undefined) {
    return { html: `You are not watching ${id} in this chat.`, buttons: [[{ text: `👛 Watch ${id}`, route: { to: 'watch-ask' } }], [back]] };
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

// ── the trading account ─────────────────────────────────────────────────────

export interface AccountScreenInput {
  /** Undefined: this chat has no linked account. */
  readonly accountId: number | undefined;
  readonly network: NetworkName | undefined;
  readonly execution: ExecutionState | undefined;
  /** How the link is backed, FROM RECORDS (link service status). Undefined: not known here. */
  readonly ownership?: { readonly proof: 'wallet' | 'key' | 'owner'; readonly walletAddress: string | undefined };
  /** Not linked, but a wallet proved this account: ownership verified, execution waiting for a key. */
  readonly proven?: { readonly accountId: number; readonly walletAddress: string };
}

const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * THE THREE STATES, NEVER COLLAPSED: which wallet, whether it PROVED it owns
 * the account, and whether PerpGuard may EXECUTE on it (and with whose key).
 */
function ownershipLines(o: AccountScreenInput['ownership']): string[] {
  if (o === undefined) return [];
  return [
    `Wallet: ${o.walletAddress === undefined ? 'None on record' : `<code>${shortAddress(o.walletAddress)}</code>`}`,
    `Ownership: ${
      o.walletAddress !== undefined
        ? '✅ Verified by wallet signature'
        : o.proof === 'key'
          ? '⚪ Not verified by a wallet: connected with an API key'
          : '⚪ Not verified: linked as this deployment\'s owner'
    }`,
  ];
}

/**
 * 🔐 TRADING ACCOUNT. The account, its network and its EXECUTION state are
 * shown as separate facts and never folded into one "connected". Wallet and
 * ownership rows join when the proof is persisted (Phase 10–11).
 */
export function accountScreen(input: AccountScreenInput): Screen {
  if (input.accountId === undefined && input.proven !== undefined) {
    const p = input.proven;
    return {
      html: [
        '🔐 <b>TRADING ACCOUNT</b>',
        '',
        `Account: <b>#${p.accountId}</b> · not connected yet`,
        `Network: ${networkLabel(input.network)}`,
        `Wallet: <code>${shortAddress(p.walletAddress)}</code>`,
        'Ownership: ✅ Verified by wallet signature',
        'Execution: ⚪ No API key yet',
        '',
        `Your wallet proved it owns #${p.accountId}. For PerpGuard to act on it, it also needs an API key for #${p.accountId}: paste it on the connect page, never here in Telegram.`,
      ].join('\n'),
      buttons: [[{ text: '🔑 Add API key', route: { to: 'connect-go' } }], [BACK_HOME]],
    };
  }
  if (input.accountId === undefined) {
    return {
      html: [
        '🔐 <b>TRADING ACCOUNT</b>',
        '',
        'Account: <b>Not connected</b>',
        `Network: ${networkLabel(input.network)}`,
        'Execution: ⚪ Not configured',
        '',
        'Connecting lets PerpGuard add margin, reduce or close a position, each time only after you confirm here.',
        'It can never withdraw or transfer your funds: a Perpl API key has no permission to move money out.',
      ].join('\n'),
      buttons: [[{ text: '🌈 Connect Wallet', route: { to: 'connect-go' } }], [BACK_HOME]],
    };
  }
  const e = input.execution;
  const lines = [
    '🔐 <b>TRADING ACCOUNT</b>',
    '',
    `Account: <b>#${input.accountId}</b>`,
    `Network: ${networkLabel(input.network)}`,
    ...ownershipLines(input.ownership),
    `Execution: ${e === undefined ? '⚪ Unknown' : `${e.dot} ${esc(e.label)}${e.dot === '🟢' && input.ownership !== undefined ? (input.ownership.proof === 'key' ? ' · your API key' : " · this deployment's own key") : ''}`}`,
    'Automation: ⚪ None',
  ];
  if (e?.next !== undefined) lines.push('', esc(e.next));
  // A remedy that runs through the connect page gets its button; forwarding off does not (it needs the owner's wallet on Perpl).
  const fixable = e !== undefined && (e.dot === '🔴' || e.label === 'Not running');
  return {
    html: lines.join('\n'),
    buttons: [
      ...(fixable ? [[{ text: '🔑 Fix authorization', route: { to: 'connect-go' } } as Button]] : []),
      [{ text: `🔌 Disconnect account #${input.accountId}`, route: { to: 'disconnect-ask' } }],
      [BACK_HOME],
    ],
  };
}

/** The one-time page link. The proof happens there; nothing secret is ever typed here. */
export function connectGoScreen(url: string, minutes: number): Screen {
  return {
    html: [
      '🌈 <b>Prove the account is yours</b>',
      `Open the page below. It works once, for ${minutes} minutes, and proves nothing by itself: there you sign with the wallet that owns the account, or paste an API key for it.`,
      '',
      'Never paste a key here in Telegram — only on that page.',
      '',
      esc(url),
    ].join('\n'),
    buttons: [[{ text: '🌈 Open the connect page', url }], [{ text: '← Back', route: { to: 'account' } }]],
  };
}

/** A sentence when a link cannot be offered at all. */
export function connectUnavailableScreen(): Screen {
  return { html: 'Connecting an account is not available on this deployment. You can still watch any account.', buttons: [[{ text: '← Back', route: { to: 'account' } }]] };
}
