/**
 * 👁 WATCH & ALERTS: every screen of the read-only half past the menu. Pure:
 * data in, Telegram HTML and buttons out. No screen here has an action button:
 * each one reads the index or changes this chat's own alert settings.
 *
 * EACH SCREEN STATES ITS OWN LIMITS (owner, 6 Oct 2026): how far behind the
 * chain the index is, that watched wallets are re-read every 30 seconds, that
 * about 6% of fills have no recorded taker, that a taker's direction comes
 * from its transaction and is sometimes not known, that past results do not
 * predict returns. A tool that says what it cannot see is believed about what
 * it can.
 */
import type { IndexerHealth, TraderRow } from '@perpguard/shared';
import { NO_BUTTONS, esc } from '@perpguard/backend/alerts/plain';
import {
  LARGE_TRADE_PRESETS_AUSD,
  LARGE_TRADES_PER_DAY,
  LIQUIDATION_PRESETS_AUSD,
  LIQUIDATIONS_PER_DAY,
  PRESET_FREQUENCY_MEASURED,
  type AlertPreferences,
} from '@perpguard/backend/events/preferences';
import { MAX_CUSTOM_LEVELS, WARNING_PRESETS, levelsLabel, presetOf } from '@perpguard/backend/events/warnings';
import { OFF_LEVEL, type Route } from './nav.ts';
import type { Button, Screen, WatchlistRow } from './screens.ts';
import { watchlistLine } from './screens.ts';

const BACK_TO_WATCH: Button = { text: '← Back', route: { to: 'watch-menu' } };
export const WATCH_EVERY_SECONDS = 30;

const grouped = (n: number): string => Math.round(n).toLocaleString('en-US');
const usd = (n: number): string => `$${n >= 1_000 ? `${n / 1_000}K` : grouped(n)}`;
/** "+128,440 AUSD", bold, sign always shown. Held money is floored toward zero. */
const signedAusd = (n: number): string => `<b>${n >= 0 ? '+' : '−'}${grouped(Math.trunc(Math.abs(n)))} AUSD</b>`;

/** "+312% on 41,000 AUSD deposited", or why there is no ROI. Never ROI without its denominator. */
export function roiPhrase(row: Pick<TraderRow, 'roiPct' | 'depositedAusd'>): string {
  if (row.roiPct === undefined) return `no ROI: under 100 AUSD deposited (${grouped(Math.trunc(row.depositedAusd))})`;
  const pct = Math.abs(row.roiPct) >= 100 ? grouped(row.roiPct) : row.roiPct.toFixed(1);
  return `<b>${row.roiPct >= 0 ? '+' : ''}${pct}%</b> on ${grouped(Math.trunc(row.depositedAusd))} AUSD deposited`;
}

/** "72% (9 of 12 round trips)", or why it is withheld. */
export function winRatePhrase(row: Pick<TraderRow, 'winRate' | 'wins' | 'roundTrips'>): string {
  return row.winRate === undefined
    ? `not shown: ${row.roundTrips} round trip${row.roundTrips === 1 ? '' : 's'}, under 10`
    : `${Math.round(row.winRate * 100)}% (${row.wins} of ${row.roundTrips} round trips)`;
}

/** "Read off the mainnet index, 140 blocks behind the chain." */
export function indexLimitsLine(health: IndexerHealth | undefined): string {
  const behind = health?.blocksBehind === undefined ? '' : `, ${grouped(health.blocksBehind)} block${health.blocksBehind === 1 ? '' : 's'} behind the chain`;
  return `<i>Read off the mainnet index${behind}. Watched wallets are re-read every ${WATCH_EVERY_SECONDS} seconds.</i>`;
}

// ── the menu ────────────────────────────────────────────────────────────────

export function watchMenuScreen(input: { readonly watching: number; readonly starred: number; readonly maxPerChat: number; readonly health: IndexerHealth | undefined }): Screen {
  return {
    html: [
      '👁 <b>WATCH & ALERTS</b>',
      'Read-only. No wallet, no key.',
      '',
      input.watching === 0 ? 'Not watching any wallet yet.' : `Watching ${input.watching} of ${input.maxPerChat}${input.starred === 0 ? '' : ` · ${input.starred} on your Watchlist`}`,
      '',
      indexLimitsLine(input.health),
    ].join('\n'),
    buttons: [
      [
        { text: '👛 Watch wallet', route: { to: 'wallets' } },
        { text: '⭐ Watchlist', route: { to: 'watchlist' } },
      ],
      [
        { text: '💥 Liquidations', route: { to: 'liq' } },
        { text: '🐋 Large trades', route: { to: 'big' } },
      ],
      [
        { text: '⚠️ Warning levels', route: { to: 'warn-levels' } },
        { text: '⚙️ Alert settings', route: { to: 'alert-settings' } },
      ],
      [{ text: '← Back', route: { to: 'home' } }],
    ],
  };
}

// ── watched wallets ─────────────────────────────────────────────────────────

/** 👛 Every wallet this chat watches, starred or not. */
export function walletsScreen(rows: readonly WatchlistRow[], maxPerChat: number): Screen {
  const add: Button[] = rows.length < maxPerChat ? [{ text: '➕ Watch a wallet', route: { to: 'watch-ask' } }] : [];
  if (rows.length === 0) {
    return { html: '👛 <b>WATCHED WALLETS</b>\nNone yet. Watch any Perpl account by its address or account id; no wallet needed.', buttons: [add, [BACK_TO_WATCH]] };
  }
  const wallets: Button[][] = [];
  for (let i = 0; i < rows.length; i += 3) {
    wallets.push(rows.slice(i, i + 3).map((row) => ({ text: `${row.sub.starred === true ? '⭐ ' : ''}#${row.sub.accountId}`, route: { to: 'wallet', accountId: row.sub.accountId } }) as Button));
  }
  return {
    html: [`👛 <b>WATCHED WALLETS</b> · ${rows.length} of ${maxPerChat}`, '', ...rows.map(watchlistLine), '', '<i>The percentage is how far the price can move against them before the exchange closes it.</i>'].join('\n'),
    buttons: [...wallets, ...(add.length === 0 ? [] : [add]), [BACK_TO_WATCH]],
  };
}

/** ✅ WALLET ADDED (spec 21): what this chat will hear about, and where to go next. */
export function walletAddedScreen(input: { readonly accountId: number; readonly label: string; readonly already: boolean; readonly starred: boolean; readonly via: string }): Screen {
  const id = input.accountId;
  const lines = [input.already ? `👛 <b>Already watching #${id}</b>` : `✅ <b>WALLET ADDED</b> · #${id}${input.via}`];
  if (input.label.startsWith('0x')) lines.push(`<code>${esc(input.label)}</code>`);
  lines.push(
    '',
    "I'll tell you about:",
    '• position opens, increases, reductions and closes',
    '• getting close to liquidation, at your warning levels',
    '• liquidation',
    '',
    `<i>From the mainnet index, re-read every ${WATCH_EVERY_SECONDS} seconds: a change can arrive a minute or so after it happened.</i>`,
    NO_BUTTONS,
  );
  return {
    html: lines.join('\n'),
    buttons: [
      [{ text: '👁 View wallet', route: { to: 'wallet', accountId: id } }],
      [input.starred ? { text: '⭐ On your Watchlist', route: { to: 'watchlist' } } : { text: '⭐ Add to Watchlist', route: { to: 'star', accountId: id } }],
      [{ text: '🗑 Stop watching', route: { to: 'unwatch', accountId: id } }],
      [BACK_TO_WATCH],
    ],
  };
}

// ── the watchlist ───────────────────────────────────────────────────────────

export interface TraderStats {
  readonly accountId: number;
  /** The last 30 days. Undefined: no trades in the window, or not readable. */
  readonly month: TraderRow | undefined;
  /** All time, for ROI. */
  readonly lifetime: TraderRow | undefined;
}

const statLines = (s: TraderStats): string[] => [
  `30D PnL ${s.month === undefined ? '<b>no trades</b>' : signedAusd(s.month.netPnlAusd)}`,
  `ROI (all time) ${s.lifetime === undefined ? 'unknown' : roiPhrase(s.lifetime)}`,
];

/** ⭐ WATCHLIST: the traders this chat follows closely (spec 22). The bridge from watching to acting. */
export function watchlistScreen(stats: readonly TraderStats[]): Screen {
  if (stats.length === 0) {
    return {
      html: '⭐ <b>WATCHLIST</b>\nEmpty. Star a wallet you watch to follow it here with its PnL and ROI.',
      buttons: [[{ text: '👛 Watched wallets', route: { to: 'wallets' } }], [BACK_TO_WATCH]],
    };
  }
  const lines = ['⭐ <b>WATCHLIST</b>', ''];
  stats.forEach((s, i) => lines.push(`${i + 1}. <b>#${s.accountId}</b>`, ...statLines(s).map((l) => `   ${l}`), ''));
  lines.push('<i>Past results do not predict future returns.</i>');
  return {
    html: lines.join('\n'),
    // Each wallet opens; ☆ takes it off the Watchlist (it stays watched).
    buttons: [...stats.map((s): Button[] => [{ text: `👁 #${s.accountId}`, route: { to: 'wallet', accountId: s.accountId } }, { text: '☆ Remove', route: { to: 'unstar', accountId: s.accountId } }]), [BACK_TO_WATCH]],
  };
}

// ── the feeds' thresholds ───────────────────────────────────────────────────

function thresholdButtons(presets: readonly number[], perDay: Readonly<Record<number, number>>, current: number | undefined, route: 'liq-set' | 'big-set'): Button[][] {
  const mark = (on: boolean) => (on ? '✅ ' : '');
  return [
    ...presets.map((p, i): Button[] => [{ text: `${mark(current === p)}${usd(p)}+ · about ${perDay[p]} a day`, route: { to: route, level: i } }]),
    [{ text: `${mark(current === undefined)}⚪ Off`, route: { to: route, level: OFF_LEVEL } }],
  ];
}

export function liquidationsScreen(current: number | undefined): Screen {
  return {
    html: [
      '💥 <b>LIQUIDATION ALERTS</b>',
      `Every liquidation on Perpl at or above your threshold, on any account. Now: <b>${current === undefined ? 'Off' : `${usd(current)}+`}</b>.`,
      '',
      `<i>How often each fired, per day, over ${PRESET_FREQUENCY_MEASURED}. Wallets you watch are always reported, at any size.</i>`,
    ].join('\n'),
    buttons: [...thresholdButtons(LIQUIDATION_PRESETS_AUSD, LIQUIDATIONS_PER_DAY, current, 'liq-set'), [BACK_TO_WATCH]],
  };
}

export function largeTradesScreen(current: number | undefined): Screen {
  return {
    html: [
      '🐋 <b>LARGE TRADES</b>',
      `Every taker order at or above your threshold, on any account. Now: <b>${current === undefined ? 'Off' : `${usd(current)}+`}</b>.`,
      '',
      'An order is one taker in one transaction, all its fills added up.',
      '<i>About 6% of fills carry no recorded taker and are not counted. The index does not record which way a taker traded, so the direction is read from the transaction, and is sometimes not known.</i>',
      `<i>How often each fired, per day, over ${PRESET_FREQUENCY_MEASURED}.</i>`,
    ].join('\n'),
    buttons: [...thresholdButtons(LARGE_TRADE_PRESETS_AUSD, LARGE_TRADES_PER_DAY, current, 'big-set'), [BACK_TO_WATCH]],
  };
}

// ── warning levels ──────────────────────────────────────────────────────────

const PRESET_ORDER = ['early', 'standard', 'late'] as const;
const PRESET_LABEL: Readonly<Record<(typeof PRESET_ORDER)[number], string>> = { early: '🟢 Early', standard: '🟡 Standard', late: '🔴 Late' };
/** The preset a `warn-preset` level index names. */
export const presetAt = (level: number): readonly number[] | undefined => (level === OFF_LEVEL ? [] : level >= 0 && level < PRESET_ORDER.length ? WARNING_PRESETS[PRESET_ORDER[level]!] : undefined);

export function warningLevelsScreen(levels: readonly number[]): Screen {
  const now = presetOf(levels);
  const mark = (on: boolean) => (on ? '✅ ' : '');
  return {
    html: [
      '⚠️ <b>LIQUIDATION WARNINGS</b>',
      `For the wallets you watch: how far from liquidation a position is when I warn you. Now: <b>${levelsLabel(levels)}</b>.`,
      '',
      'Each level warns once, then waits until the position recovers past it before it can warn again. A fall through several at once is one warning.',
      `<i>Positions are re-read every ${WATCH_EVERY_SECONDS} seconds from the index, which itself trails the chain: a fast fall can pass a level between two reads.</i>`,
      "<i>Your own account's alert distance is in ⚙️ Settings.</i>",
    ].join('\n'),
    buttons: [
      ...PRESET_ORDER.map((name, i): Button[] => [{ text: `${mark(now === name)}${PRESET_LABEL[name]} — ${levelsLabel(WARNING_PRESETS[name])}`, route: { to: 'warn-preset', level: i } }]),
      [{ text: `${mark(now === 'custom')}🎛 Custom${now === 'custom' ? ` — ${levelsLabel(levels)}` : ''}`, route: { to: 'warn-custom' } }],
      [{ text: `${mark(now === 'off')}⚪ Off`, route: { to: 'warn-preset', level: OFF_LEVEL } }],
      [BACK_TO_WATCH],
    ],
  };
}

export const WARNING_LEVELS_PROMPT = `Send up to ${MAX_CUSTOM_LEVELS} levels, in percent, like <b>15 8 3</b>. Each above 0 and at most 100.`;

export function warningCustomAskScreen(): Screen {
  return { html: `🎛 <b>CUSTOM WARNING LEVELS</b>\n${WARNING_LEVELS_PROMPT}`, buttons: [[{ text: '← Back', route: { to: 'warn-levels' } }]] };
}

// ── alert settings ──────────────────────────────────────────────────────────

/** ⚙️ ALERT SETTINGS (spec 29): each line says what it is set to; each button goes to where it is changed. */
export function alertSettingsScreen(p: AlertPreferences): Screen {
  return {
    html: [
      '⚙️ <b>ALERT SETTINGS</b>',
      '',
      `Wallet alerts: ${p.walletAlerts ? '🟢 ON' : '⚪ OFF'}`,
      `Liquidations: <b>${p.liquidationMinAusd === undefined ? 'Off' : `${usd(p.liquidationMinAusd)}+`}</b>`,
      `Large trades: <b>${p.largeTradeMinAusd === undefined ? 'Off' : `${usd(p.largeTradeMinAusd)}+`}</b>`,
      `Warnings: <b>${levelsLabel(p.warningLevels)}</b>`,
      '',
      '<i>Wallet alerts are the changes on wallets you watch. Liquidations and large trades are the whole exchange. At most 10 of those a minute reach this chat; any more are counted in one line.</i>',
    ].join('\n'),
    buttons: [
      [{ text: p.walletAlerts ? '🔕 Turn wallet alerts off' : '🔔 Turn wallet alerts on', route: { to: 'wallet-alerts' } }],
      [
        { text: '💥 Liquidations', route: { to: 'liq' } },
        { text: '🐋 Large trades', route: { to: 'big' } },
      ],
      [{ text: '⚠️ Warning levels', route: { to: 'warn-levels' } }],
      [BACK_TO_WATCH],
    ],
  };
}

