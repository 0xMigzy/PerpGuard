/**
 * THE BOT MAP, GENERATED FROM THE REAL BOT (owner, 7 Oct 2026).
 *
 *   pnpm bot:map                     # writes /root/perpguard-bot-map.md and prints it
 *   pnpm bot:map --out /some/path.md
 *
 * Drives the real `createBot` (only Telegram's wire and the session faked:
 * `botWorld.ts`) through every command, every button and every typed answer,
 * as the linked owner and as a stranger, and renders every pushed message
 * kind through its real renderer. For each screen: its text (live figures
 * replaced by placeholders), its buttons in their rows and where each leads,
 * the tier, and the file and line its words live on (found by searching the
 * source for the screen's own words). Then the flows, the copy shared between
 * screens, and anything a user can reach that the walk did not cover.
 *
 * THE OUTPUT NEVER GOES IN THE REPO: the default path is outside the tree.
 */
import { ApiSecret, type AccountLookup } from '@perpguard/shared';
import { InMemoryIdentityStore, InMemoryLinkStore } from '@perpguard/bot';
import { LinkCodeStore } from '../server/protect/session.ts';
import { KeyVault } from '../server/link/crypto.ts';
import { LinkService } from '../server/link/service.ts';
import { InMemoryKeyStore } from '../server/link/stores.ts';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BOT_MENU_COMMANDS, StaticSessionRouter, TelegramAlertTransport, createManualAlertSender, decodeCallback, decodeNav, encodeNav, isPublicRoute, type Route } from '@perpguard/bot';
import { CONFIGS, FakeBalance, FakeExecutor, FakeView, OWNER_CHAT, OWNER_ID, OWNER_LINK, STRANGER_ID, callbackUpdate, dangerAssessment, dangerScenario, fakeBot, messageUpdate, newLinks, newStore, type TelegramCall } from '@perpguard/bot/test-support';
import { buildMessage } from '../alerts/render.ts';
import { replacedByManualAlert } from '../manual/replaced.ts';
import { DEFAULT_ALERT_CONFIG, type AlertKind } from '../alerts/types.ts';
import { renderLargeTrade, renderLiquidation, renderPositionChange, renderWarning } from '../events/render.ts';
import { renderRescue, type RescueNotice } from '../rescue/render.ts';
import { watchInsteadText } from '../watch/insteadText.ts';
import type { RescueRule } from '../rescue/store.ts';
import { CHANGES, STRANGER_CHAT, build, type Keyboard } from './botWorld.ts';

const { values } = parseArgs({ options: { out: { type: 'string', default: '/root/perpguard-bot-map.md' } } });
const ROOT = resolve(import.meta.dirname, '../../../..');
const OUT = resolve(values.out);
if (OUT.startsWith(`${ROOT}/`)) throw new Error(`refusing to write the map inside the repo (${OUT}); it lives outside the working tree`);

type Tier = 'everyone' | 'watch-only' | 'linked testnet';
interface Btn {
  readonly label: string;
  /** Where it leads: a screen name, a URL, or what it does. */
  readonly target: string;
  readonly source: string | undefined;
}
interface Screen {
  readonly key: string;
  readonly name: string;
  readonly group: string;
  readonly tier: Tier;
  readonly reachedBy: Set<string>;
  readonly seenAs: Set<string>;
  readonly raw: string;
  readonly text: string;
  readonly rows: readonly (readonly Btn[])[];
  readonly source: string | undefined;
  readonly toasts: Set<string>;
}

// ── the source, for "where does this text live" ──────────────────────────────
const SOURCE_DIRS = ['apps/bot/src', 'apps/backend/src'];
const sourceLines: Array<{ readonly file: string; readonly line: number; readonly text: string }> = [];
const walkDir = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkDir(full);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !full.includes('/scripts/')) {
      readFileSync(full, 'utf8').split('\n').forEach((text, i) => sourceLines.push({ file: relative(ROOT, full), line: i + 1, text: text.replace(/<\/?(b|i|code)>/g, '') }));
    }
  }
};
for (const d of SOURCE_DIRS) walkDir(join(ROOT, d));

const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const plain = (html: string): string => unescape(html.replace(/<\/?(b|i|code|a[^>]*)>/g, ''));
const BADGE = /^testnet$/;

/** The longest stretch of literal words in `text`, split where figures and names vary. */
function fragments(text: string): string[] {
  return text
    .split(/[0-9]+(?:[.,][0-9]+)*|#\w+|0x[0-9a-fA-F…]+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
    .sort((a, b) => b.length - a.length);
}
const sourceCache = new Map<string, string | undefined>();
function findSource(text: string): string | undefined {
  const lines = plain(text).split('\n').filter((l) => l.trim() !== '' && !BADGE.test(l.trim()));
  for (const line of lines.slice(0, 3)) {
    // The longest literal stretches first, then shorter runs of words: a line built from parts
    // still has a few words in a row that live in the source as written.
    const words = line.trim().split(/\s+/);
    const windows: string[] = [];
    for (let w = Math.min(7, words.length); w >= 3; w -= 1) for (let i = 0; i + w <= words.length; i += 1) windows.push(words.slice(i, i + w).join(' '));
    const candidates = [...fragments(line).slice(0, 3), ...windows.filter((c) => c.length >= 14 && !/[0-9#{]/.test(c)).slice(0, 40)];
    for (const frag of candidates) {
      if (sourceCache.has(frag)) {
        const hit = sourceCache.get(frag);
        if (hit !== undefined) return hit;
        continue;
      }
      const bare = frag.replace(/'/g, "’");
      const hits = sourceLines.filter((s) => s.text.includes(frag) || s.text.includes(bare) || s.text.replace(/\\'/g, "'").includes(frag));
      const best = hits.find((h) => h.file.startsWith('apps/bot/')) ?? hits[0];
      const where = best === undefined ? undefined : `${best.file}:${best.line}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`;
      sourceCache.set(frag, where);
      if (where !== undefined) return where;
    }
  }
  return undefined;
}
function findLabelSource(label: string, near?: string): string | undefined {
  // The label exactly as a string literal on a line that builds a button; of several, the one
  // nearest the screen's own text (same file, at or after its line), and how many others there are.
  const quoted = [`'${label}'`, `"${label}"`, `\`${label}\``];
  let hits = sourceLines.filter((l) => l.text.includes('text:') && quoted.some((q) => l.text.includes(q)));
  if (hits.length === 0) hits = sourceLines.filter((l) => quoted.some((q) => l.text.includes(q)));
  if (hits.length > 0) {
    const [nearFile, nearLine] = near === undefined ? [undefined, 0] : [near.split(':')[0], Number(near.split(':')[1]?.split(' ')[0])];
    const sameFile = hits.filter((h) => h.file === nearFile);
    const after = sameFile.filter((h) => h.line >= (nearLine ?? 0)).sort((x, y) => x.line - y.line)[0];
    const best = after ?? sameFile[0] ?? hits[0]!;
    return `${best.file}:${best.line}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`;
  }
  const literal = label.split(/[0-9]+(?:[.,][0-9]+)*|#\w+/).map((x) => x.trim()).filter((x) => x.length >= 3).sort((x, y) => y.length - x.length)[0];
  if (literal !== undefined) {
    const built = sourceLines.find((l) => l.text.includes('text:') && l.text.includes(literal));
    if (built !== undefined) return `${built.file}:${built.line}`;
  }
  const frag = label.split(/[0-9]+(?:[.,][0-9]+)*|#\w+/).map((s) => s.trim()).filter((s) => s.length >= 3).sort((a, b) => b.length - a.length)[0];
  if (frag === undefined) return undefined;
  const hit = sourceLines.find((s) => s.file.startsWith('apps/bot/') && (s.text.includes(`'${frag}`) || s.text.includes(`"${frag}`) || s.text.includes(`\`${frag}`) || s.text.includes(frag)));
  return hit === undefined ? undefined : `${hit.file}:${hit.line}`;
}

// ── placeholders for live figures ────────────────────────────────────────────
const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
function placeholders(t: string): string {
  return t
    .replace(/0x[0-9a-fA-F]{4,}(…[0-9a-fA-F]{2,})?/g, '{address}')
    .replace(/https:\/\/perpguard\.app\/link\?code=[A-Z-]+/g, '{link url}')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?: UTC)?/g, '{date}')
    .replace(new RegExp(`\\b(?:${MONTHS}) \\d{1,2}(?:, \\d{4})?(?: · \\d{2}:\\d{2})?`, 'g'), '{date}')
    .replace(/\b\d{2}\/\d{2}\b/g, '{date}')
    .replace(/\b\d+(?:\.\d+)? ?(?:min|h|s|days?) ago\b/g, '{age} ago')
    .replace(/(?<!under )([−+-]?)[\d,]+(?:\.\d+)? AUSD/g, (_m, sign: string) => `${sign}{amount} AUSD`)
    .replace(/\bAdd [\d,]+(?:\.\d+)?\b(?! ?%)/g, 'Add {amount}')
    .replace(/[−+-]?\d+\.\d+%/g, '{pct}%')
    .replace(/#\d{2,}/g, '#{account}')
    .replace(/\b(account|Account) \d{2,}\b/g, '$1 {account}')
    .replace(/\bblock [\d,]+/g, 'block {block}')
    .replace(/\b\d+(?:\.\d+)?x\b/g, '{lev}x')
    .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b/g, '{n}');
}
/** Telegram HTML as a reader sees it, with bold and italic kept as markers. */
const shown = (html: string): string => placeholders(unescape(html.replace(/<b>/g, '**').replace(/<\/b>/g, '**').replace(/<\/?i>/g, '_').replace(/<\/?code>/g, '`').replace(/<a [^>]*>|<\/a>/g, '')));

// ── tiers and groups ─────────────────────────────────────────────────────────
const EVERYONE = new Set(['home', 'account', 'connect', 'connect-go', 'connect-key']);
function tierOfRoute(name: string): Tier {
  if (EVERYONE.has(name)) return 'everyone';
  if (isPublicRoute({ to: name } as Route)) return 'watch-only';
  return 'linked testnet';
}
const GROUP_OF: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(home|\/start|\/help|chatter|dismiss)$/, '1. Start, home and help'],
  [/^(account|connect|connect-go|connect-key|disconnect-ask|disconnect|\/link)$/, '2. Linking and the Trading account'],
  [/^(watch-menu|watch-ask|watch-ask answer|watch-id|watchlist|wallets|wallet|star|unstar|unwatch|liq|liq-set|big|big-set|warn-levels|warn-preset|warn-custom|alert-settings|wallet-alerts|\/watch.*|pasted .*|bare number)$/, '3. Watch & Alerts (watch tier)'],
  [/^(positions|position|action:.*|typed amount.*|close-pos.*|close-part.*|typed close percent.*)$/, '4. My positions and adding margin'],
  [/^(rescue.*)$/, '5. Rescue'],
  [/^(settings|warn-ask|warn-set|alert-custom|typed alert distance.*)$/, '6. Settings'],
  [/^(kill.*|stop-all.*|close-.*)$/, '7. Kill switch'],
  [/^pushed:/, '8. Messages PerpGuard sends on its own'],
];
const groupOf = (name: string): string => {
  const bare = name.replace(/ \((question|toast only|refused|not confirmed)\)$/, '');
  return GROUP_OF.find(([re]) => re.test(bare))?.[1] ?? '9. Other';
};

// ── the screens collected ────────────────────────────────────────────────────
const screens = new Map<string, Screen>();
const reachedRoutes = new Set<string>();
const reachedKinds = new Set<string>();
const titleOf = (html: string): string => {
  const first = plain(html).split('\n').map((l) => l.trim()).find((l) => l !== '' && !BADGE.test(l)) ?? '(empty)';
  return placeholders(first).slice(0, 70);
};
function addScreen(trigger: string, html: string, keyboard: Keyboard | undefined, who: string, tier: Tier, toast?: string): Screen {
  const text = shown(html);
  const key = `${trigger}|${text}`;
  const existing = screens.get(key);
  if (existing !== undefined) {
    existing.seenAs.add(who);
    if (toast !== undefined) existing.toasts.add(toast);
    return existing;
  }
  const source = findSource(html);
  const rows = (keyboard?.inline_keyboard ?? []).map((row) => row.map((b) => ({ label: placeholders(b.text), target: targetOf(b), source: findLabelSource(b.text, source) })));
  const s: Screen = { key, name: `${trigger} · ${titleOf(html)}`, group: groupOf(trigger), tier, reachedBy: new Set(), seenAs: new Set([who]), raw: html, text, rows, source, toasts: new Set(toast === undefined ? [] : [toast]) };
  screens.set(key, s);
  return s;
}
function targetOf(b: { readonly text: string; readonly callback_data?: string; readonly url?: string }): string {
  if (b.url !== undefined) return `opens ${placeholders(b.url)}`;
  if (b.callback_data === undefined) return '(nothing)';
  const nav = decodeNav(b.callback_data);
  if (nav !== undefined) {
    const args = Object.entries(nav).filter(([k]) => k !== 'to').map(([k, v]) => `${k}=${String(v)}`).join(', ');
    return `screen \`${nav.to}\`${args === '' ? '' : ` (${placeholders(args)})`}${CHANGES.has(nav.to) ? ' — changes a setting or state' : ''}`;
  }
  const action = decodeCallback(b.callback_data);
  if (action.ok) {
    const p = action.payload;
    const what: Record<string, string> = {
      act: 'shows the confirmation for this action (sends nothing)',
      custom: 'asks for an amount (sends nothing)',
      confirm: 'SENDS the action through the executor, then shows its outcome',
      blocked: 'says why this action is not available (sends nothing)',
      cancel: 'cancels: the confirmation is discarded and nothing is sent',
    };
    return `action \`${p.kind}\`: ${what[p.kind] ?? p.kind}`;
  }
  return '(an unreadable button)';
}

/** What one tap or message produced: every message sent or edited, and the toast. */
function delta(calls: readonly TelegramCall[], from: number): { readonly messages: ReadonlyArray<{ readonly html: string; readonly keyboard: Keyboard | undefined; readonly forceReply: boolean }>; readonly toast: string | undefined } {
  const out = calls.slice(from);
  const messages = out
    .filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
    .map((c) => ({ html: String(c.payload['text'] ?? ''), keyboard: c.payload['reply_markup'] as Keyboard | undefined, forceReply: (c.payload['reply_markup'] as { force_reply?: boolean } | undefined)?.force_reply === true }));
  const toastCall = out.find((c) => c.method === 'answerCallbackQuery' && typeof c.payload['text'] === 'string');
  return { messages, toast: toastCall === undefined ? undefined : String(toastCall.payload['text']) };
}

// ── the walk ─────────────────────────────────────────────────────────────────
const WHO = {
  owner: { from: OWNER_ID, chat: OWNER_CHAT, label: 'linked owner' },
  stranger: { from: STRANGER_ID, chat: STRANGER_CHAT, label: 'stranger (not linked)' },
} as const;

function triggerName(data: string): { readonly name: string; readonly tier: Tier } {
  const nav = decodeNav(data);
  if (nav !== undefined) {
    reachedRoutes.add(nav.to);
    return { name: nav.to, tier: tierOfRoute(nav.to) };
  }
  const a = decodeCallback(data);
  if (a.ok) {
    reachedKinds.add(a.payload.kind);
    return { name: `action:${a.payload.kind}`, tier: 'linked testnet' };
  }
  return { name: 'unknown button', tier: 'everyone' };
}

async function walk(who: (typeof WHO)[keyof typeof WHO]): Promise<void> {
  const produced = new Map<string, Screen[]>();
  const world = build({ link: true, resolver: true });
  const { bot, telegram } = world;
  const seen = new Set<string>();
  const queue: Array<{ readonly data: string; readonly parent: Screen; readonly label: string }> = [];
  const capture = (trigger: string, tier: Tier, from: number, parent: Screen | undefined, label: string): Screen[] => {
    const d = delta(telegram.calls, from);
    const made: Screen[] = [];
    for (const m of d.messages) {
      const s = addScreen(m.forceReply ? `${trigger} (question)` : trigger, m.html, m.keyboard, who.label, tier, d.toast);
      if (parent !== undefined) s.reachedBy.add(`tap "${placeholders(label)}" on \`${parent.name}\``);
      made.push(s);
      for (const row of m.keyboard?.inline_keyboard ?? []) for (const b of row) if (b.callback_data !== undefined) queue.push({ data: b.callback_data, parent: s, label: b.text });
    }
    if (d.messages.length === 0 && d.toast !== undefined && parent !== undefined) {
      const s = addScreen(`${trigger} (toast only)`, d.toast, undefined, who.label, tier);
      s.reachedBy.add(`tap "${placeholders(label)}" on \`${parent.name}\``);
      made.push(s);
    }
    return made;
  };
  const start = telegram.calls.length;
  await bot.handleUpdate(messageUpdate('/start', who));
  for (const s of capture('/start', 'everyone', start, undefined, '')) s.reachedBy.add('/start');
  while (queue.length > 0) {
    const { data, parent, label } = queue.shift()!;
    const nav = decodeNav(data);
    const action = nav === undefined ? decodeCallback(data) : undefined;
    const key = nav !== undefined ? JSON.stringify(nav) : action?.ok === true ? `${action.payload.kind}:${action.payload.marketId}:${action.payload.amountCNS}` : data;
    if (seen.has(key)) {
      for (const sc of produced.get(key) ?? []) sc.reachedBy.add(`tap "${placeholders(label)}" on \`${parent.name}\``);
      continue;
    }
    seen.add(key);
    const { name, tier } = triggerName(data);
    if (nav !== undefined && CHANGES.has(nav.to)) {
      // A button that changes something: tapped in a FRESH bot, so nothing it changes leaks into the walk.
      const fresh = build({ link: true, resolver: true });
      await fresh.bot.handleUpdate(messageUpdate('/start', who));
      const from = fresh.telegram.calls.length;
      await fresh.bot.handleUpdate(callbackUpdate(data, who));
      const d = delta(fresh.telegram.calls, from);
      const made: Screen[] = [];
      for (const m of d.messages) made.push(addScreen(name, m.html, m.keyboard, who.label, tier, d.toast));
      if (d.messages.length === 0 && d.toast !== undefined) made.push(addScreen(`${name} (toast only)`, d.toast, undefined, who.label, tier));
      for (const sc of made) sc.reachedBy.add(`tap "${placeholders(label)}" on \`${parent.name}\``);
      produced.set(key, made);
      continue;
    }
    const from = telegram.calls.length;
    await bot.handleUpdate(callbackUpdate(data, who));
    produced.set(key, capture(name, tier, from, parent, label));
  }
}

/** One message typed into a fresh bot, after optional set-up taps. */
async function typed(who: (typeof WHO)[keyof typeof WHO], trigger: string, tier: Tier, text: string, before: readonly string[] = [], how = `send "${text}"`): Promise<void> {
  const { bot, telegram } = build({ link: true, resolver: true });
  await bot.handleUpdate(messageUpdate('/start', who));
  for (const b of before) {
    if (b.startsWith('/')) await bot.handleUpdate(messageUpdate(b, who));
    else await bot.handleUpdate(callbackUpdate(b, who));
  }
  const from = telegram.calls.length;
  await bot.handleUpdate(messageUpdate(text, who));
  const d = delta(telegram.calls, from);
  for (const m of d.messages) addScreen(m.forceReply ? `${trigger} (question)` : trigger, m.html, m.keyboard, who.label, tier).reachedBy.add(how);
}

await walk(WHO.owner);
await walk(WHO.stranger);

// ── commands and typed text ──────────────────────────────────────────────────
const nav = (route: Route): string => encodeNav(route);
for (const who of [WHO.owner, WHO.stranger]) {
  await typed(who, '/help', 'everyone', '/help');
  await typed(who, '/link', 'everyone', '/link');
  await typed(who, '/watch', 'watch-only', '/watch');
  await typed(who, '/watch <address>', 'watch-only', '/watch 0xB7854953A71e45D1033B3d619E76d56391291765');
  await typed(who, 'pasted address', 'watch-only', '0xB7854953A71e45D1033B3d619E76d56391291765', [], 'paste an address without being asked');
  await typed(who, 'bare number', 'watch-only', '4532', [], 'send a bare number without being asked');
  await typed(who, 'chatter', 'everyone', 'hello', [], 'send anything else');
  await typed(who, 'watch-ask answer', 'watch-only', '4532', [nav({ to: 'watch-ask' })], 'answer the Watch Wallet question');
}
await typed(WHO.owner, 'typed alert distance', 'linked testnet', '4', [nav({ to: 'settings' }), nav({ to: 'alert-custom' })], 'answer the custom alert distance question with 4');
await typed(WHO.owner, 'typed alert distance (refused)', 'linked testnet', '99', [nav({ to: 'settings' }), nav({ to: 'alert-custom' })], 'answer it with 99 (out of range)');
await typed(WHO.owner, 'warn-custom', 'watch-only', '12 6 3', [nav({ to: 'warn-levels' }), nav({ to: 'warn-custom' })], 'answer the custom warning levels question');

// ── messages PerpGuard sends on its own, through their real renderers ───────
const pushed = (name: string, tier: Tier, html: string, keyboard: Keyboard | undefined, when: string): void => {
  addScreen(`pushed: ${name}`, html, keyboard, 'recipient', tier).reachedBy.add(when);
  for (const row of keyboard?.inline_keyboard ?? []) for (const b of row) if (b.callback_data !== undefined) pushedTargets.add(decodeNav(b.callback_data)?.to ?? '');
};
const pushedTargets = new Set<string>();
{
  // Manual alert (the crossing), its three forms, through the real sender.
  const { bot, telegram } = fakeBot();
  const view = new FakeView();
  // The loop behind the sample position, so the alert's amounts are priced as in production.
  const scenario = dangerScenario();
  view.loop = scenario.loop;
  view.assessments = [scenario.assessment];
  const send = createManualAlertSender({
    api: bot.api,
    store: newStore(),
    links: newLinks(),
    sessions: new StaticSessionRouter([{ accountId: 710, view, executor: new FakeExecutor(), balance: new FakeBalance() }]),
    configs: CONFIGS,
    alerts: { bufferDecimals: 1 },
    network: 'testnet',
  });
  const a = dangerAssessment();
  for (const [name, auto] of [
    ['manual alert', { kind: 'off' }],
    ['manual alert (Auto adding)', { kind: 'adding', amountCNS: 100_000_000n, used: 0, max: 2 }],
    ['manual alert (Auto waiting)', { kind: 'waiting', why: 'its cooldown has 9 minutes left' }],
  ] as const) {
    const from = telegram.calls.length;
    await send({ accountId: 710, assessment: a, alertPct: 5, auto });
    const d = delta(telegram.calls, from);
    for (const m of d.messages) pushed(name, 'linked testnet', m.html, m.keyboard, 'a linked position reaches the account\'s alert distance');
  }
  // Linked engine alerts (past liquidation, cannot see, can see again) and watch-tier copies.
  const transport = new TelegramAlertTransport({ api: bot.api, token: 'x', links: newLinks(), store: newStore(), executor: new FakeExecutor() });
  const market = CONFIGS.get(a.marketId)!;
  // Only what production actually sends: a linked account's danger/watch (and their plain
  // "recovered") are REPLACED by the manual alert (`replacedByManualAlert`); watchers get only
  // "I cannot see it" and "I can see it again" (server.ts, the watch engine's recipients).
  const blind = (st: string | undefined) => st === 'FEED_DOWN' || st === 'POSITIONS_UNTRUSTED';
  const variants: Array<{ kind: AlertKind; state: string; previousState: string | undefined; label: string }> = [
    { kind: 'past-liquidation', state: 'PAST_LIQUIDATION', previousState: 'DANGER', label: 'past liquidation' },
    { kind: 'danger', state: 'DANGER', previousState: 'WATCH', label: 'danger' },
    { kind: 'watch', state: 'WATCH', previousState: 'SAFE', label: 'watch' },
    { kind: 'recovered', state: 'SAFE', previousState: 'DANGER', label: 'recovered' },
    { kind: 'feed-down', state: 'FEED_DOWN', previousState: 'DANGER', label: 'cannot see: prices' },
    { kind: 'positions-untrusted', state: 'POSITIONS_UNTRUSTED', previousState: 'DANGER', label: 'cannot see: positions' },
    { kind: 'recovered', state: 'DANGER', previousState: 'FEED_DOWN', label: 'can see again' },
  ];
  for (const v of variants) {
    const base = { ...a, state: v.state as never, previousState: v.previousState as never, ...(v.kind === 'past-liquidation' ? { liqBufferPct: -0.004 } : {}) };
    for (const rights of ['act', 'watch'] as const) {
      const scoped = rights === 'watch' ? { ...base, accountId: 4532, watch: { accountId: 4532, label: '#4532', indexerBlock: 111_124_139, blocksBehind: 140, indexerState: 'synced', freeBalanceCNS: 12_500_000_000n } } : base;
      let message;
      try {
        message = buildMessage(scoped as typeof a, v.kind, { alerts: DEFAULT_ALERT_CONFIG, market });
      } catch {
        continue;
      }
      if (rights === 'act' && replacedByManualAlert(message)) continue;
      if (rights === 'watch' && !blind(v.state) && !blind(v.previousState)) continue;
      const from = telegram.calls.length;
      await transport.send(rights === 'act' ? { userId: OWNER_LINK.userId, rights } : { userId: 'watcher', rights, chatId: STRANGER_CHAT }, message);
      const d = delta(telegram.calls, from);
      for (const m of d.messages) pushed(`${v.label} (${rights === 'act' ? 'linked' : 'watcher'})`, rights === 'act' ? 'linked testnet' : 'watch-only', m.html, m.keyboard, rights === 'act' ? `the linked account's own loop: ${v.label}` : `a watched account: ${v.label}`);
    }
  }
}
{
  const ctx = { webUrl: 'https://perpguard.app', watchEveryMs: 30_000 };
  const fresh = { indexerBlock: 111_124_139, blocksBehind: 140 };
  const liq = { id: 'tx-1', atMs: Date.parse('2026-10-07T12:00:00Z'), txHash: '0xabc123abc123', market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC' }, accountId: 4532, side: 'long' as const, kind: 'liquidation' as never, isFull: true, sizeLots: 0.5, markPrice: 120_150.5, execPrice: 120_100.2, notionalAusd: 60_050, marginLostAusd: 4_210, badDebtAusd: 0, freeBalanceBeforeAusd: 12_500, marginToSurviveAusd: 900, verdict: 'rescuable' as never, blockNumber: 111_124_100, logIndex: 3, entryPrice: 128_000, realizedPnlAusd: -3_950, fundingAusd: -12 };
  const kb = (links: ReadonlyArray<{ text: string; url: string }>): Keyboard => ({ inline_keyboard: links.length === 0 ? [] : [links.map((l) => ({ text: l.text, url: l.url }))] });
  for (const why of ['watching', 'feed'] as const) {
    const r = renderLiquidation({ kind: 'liquidation', id: 'e1', liquidation: liq, freshness: fresh } as never, why, ctx);
    pushed(`liquidation (${why === 'watching' ? 'a watched wallet' : 'the feed'})`, why === 'watching' ? 'watch-only' : 'everyone', r.html, kb(r.links), why === 'watching' ? 'a watched wallet is liquidated, any size' : 'any liquidation at or above the chat\'s threshold');
  }
  const order = { id: 'o1', txHash: '0xdef456def456', blockNumber: 111_124_120, atMs: Date.parse('2026-10-07T12:00:00Z'), market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC' }, accountId: 4532, sizeLots: 0.4, notionalAusd: 48_060, averagePrice: 120_150.5, fills: 3 };
  for (const direction of [{ action: 'open' as const, side: 'long' as const }, undefined]) {
    const r = renderLargeTrade({ kind: 'large-trade', id: 'e2', order, direction, freshness: fresh } as never, ctx);
    pushed(`large trade (${direction === undefined ? 'direction not known' : 'direction known'})`, 'everyone', r.html, kb(r.links), 'any taker order at or above the chat\'s threshold');
  }
  for (const kind of ['position-opened', 'position-increased', 'position-reduced', 'position-closed'] as const) {
    const r = renderPositionChange({ kind, id: 'e3', accountId: 4532, market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC' }, side: 'long', sizeBefore: kind === 'position-opened' ? 0 : 0.5, sizeAfter: kind === 'position-closed' ? 0 : 0.8, entryPrice: 120_000, marginAusd: 9_600, leverage: 10, openedAtMs: Date.parse('2026-10-07T11:00:00Z'), seenAtMs: Date.parse('2026-10-07T12:00:00Z'), freshness: fresh } as never, ctx);
    pushed(`watched wallet: ${kind.replace('position-', '')}`, 'watch-only', r.html, kb(r.links), 'a watched wallet\'s position changes (checked every 30 s)');
  }
  const r = renderWarning({ ...dangerAssessment(), accountId: 4532, watch: { accountId: 4532, label: '#4532', indexerBlock: 111_124_139, blocksBehind: 140, indexerState: 'synced', freeBalanceCNS: 12_500_000_000n } } as never, 5, [10, 5], CONFIGS.get(dangerAssessment().marketId), ctx);
  pushed('watched wallet: warning level', 'watch-only', r.html, kb(r.links), 'a watched position crosses one of the chat\'s warning levels');
}
{
  const rule = { id: 3, accountId: 710, marketId: 16, symbol: 'BTC', positionId: 1, triggerPct: 0.05, amountCNS: 100_000_000n, maxRescues: 2, maxTotalCNS: 200_000_000n, minRemainingCNS: 500_000_000n, cooldownMs: 900_000, rescueCount: 1, totalRescuedCNS: 100_000_000n, enabled: true, pausedReason: undefined, lastAttemptAtMs: 0, lastNotice: undefined, createdAtMs: 0, armedBy: 7, armedChat: 7, armedAtMs: 0, armProof: 'x' } as RescueRule;
  const a = dangerAssessment();
  const notices: RescueNotice[] = [
    { kind: 'rescued', rule, triggerDistancePct: 0.049, appliedCNS: 100_000_000n, marginBeforeCNS: 2_810_000_000n, marginAfterCNS: 2_910_000_000n, distanceAfterPct: 0.061, receiptDisagreed: true },
    { kind: 'not-applied', rule, amountCNS: 100_000_000n, cooldownMs: 900_000 },
    { kind: 'paused', rule, amountCNS: 100_000_000n, detail: 'the position could not be read after the send' },
    { kind: 'paused-refused', rule, detail: 'the market is closed on testnet' },
    { kind: 'exhausted', rule, assessment: a, why: 'both top-ups are used' },
    ...(['stopped', 'feed-down', 'positions-untrusted', 'unassessed', 'market-closed', 'cooldown', 'balance-unknown', 'balance-low', 'no-session', 'in-flight', 'refused'] as const).map(
      (reason): RescueNotice => ({ kind: 'held', rule, reason, detail: `held: ${reason}`, assessment: a }),
    ),
    { kind: 'ended', rule, detail: 'the position is closed', cause: 'position' },
    { kind: 'ended', rule, detail: 'testnet no longer lists BTC', cause: 'market' },
  ];
  for (const n of notices) {
    const r = renderRescue(n, 6);
    pushed(`Auto top-up: ${n.kind}${n.kind === 'ended' ? ` (${n.cause})` : n.kind === 'held' ? ` (${n.reason})` : ''}`, 'linked testnet', r.html, { inline_keyboard: [r.buttons.map((b) => ({ text: b.text, callback_data: encodeNav(b.route === 'rescue' ? { to: 'rescue' } : b.route === 'position' ? { to: 'position', marketId: 16 } : { to: 'rescue-stop', marketId: 16 }) }))] }, 'Auto top-up acts, or holds, on an armed position');
  }
}
{
  // The link service's own notices, through the REAL LinkService with in-memory stores.
  const said: string[] = [];
  const make = (forwardingAllowed: boolean) =>
    new LinkService({
      codes: new LinkCodeStore({ purpose: 'link', now: () => 1_000 }),
      identities: new InMemoryIdentityStore(),
      links: new InMemoryLinkStore({ capacity: 5 }),
      keys: new InMemoryKeyStore(),
      vault: new KeyVault('3'.repeat(64)),
      registry: { open: () => ({ ok: true, session: {} as never, already: false }), close: async () => true, get: () => ({ status: () => ({}) }) as never },
      probe: async () => ({ accountId: 711, forwardingAllowed }),
      lookupAccount: async (address: string): Promise<AccountLookup> => ({ found: true, accountId: 710, address }),
      secretFromHex: (hex: string) => ApiSecret.fromHex(hex),
      envAccountId: 710,
      webUrl: 'https://perpguard.app/',
      notify: async (_chatId: number, text: string) => {
        said.push(text);
      },
      logger: { info: () => {}, warn: () => {} },
      now: () => 2_000,
    });
  const identity = { userId: 'tg:4242', telegramUserId: 4242, chatId: 5150 } as never;
  await make(true).proveWallet(identity, ['0xb7854953a71e45d1033b3d619e76d56391291765']);
  pushed('linked (wallet proof)', 'linked testnet', said.at(-1) ?? '', undefined, 'the /link page verified a wallet that owns the deployment account');
  const secret = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
  await make(true).proveKey(identity, { apiKey: 'sample-api-key-0123456789abcdef0123456789', secretHex: secret }, undefined);
  pushed('linked (API key)', 'linked testnet', said.at(-1) ?? '', undefined, 'the /link page signed in with a pasted API key');
  await make(false).proveKey(identity, { apiKey: 'sample-api-key-0123456789abcdef0123456789', secretHex: secret }, undefined);
  pushed('linked (API key, forwarding off)', 'linked testnet', said.at(-1) ?? '', undefined, 'the same, for an account that does not allow API-key orders yet');
}
// The watch-instead message is sent by the server when the web page's button is used.
pushed('watch it instead (from the /link page)', 'watch-only', watchInsteadText(4855), undefined, 'tap "👁 Watch it instead" on the /link web page');

// ── flows: real sequences, named by the screens they land on ────────────────
interface FlowStep {
  readonly do: string;
  readonly send?: string;
  readonly tap?: Route;
  readonly tapLabel?: string;
}
async function flow(title: string, who: (typeof WHO)[keyof typeof WHO], steps: readonly FlowStep[], notes: readonly string[] = []): Promise<string> {
  const { bot, telegram } = build({ link: true, resolver: true });
  const out = [`- **${title}** (as the ${who.label})`];
  for (const step of steps) {
    const from = telegram.calls.length;
    if (step.send !== undefined) await bot.handleUpdate(messageUpdate(step.send, who));
    else if (step.tap !== undefined) await bot.handleUpdate(callbackUpdate(encodeNav(step.tap), who));
    else if (step.tapLabel !== undefined) {
      // An action button on the last screen, found by its label.
      const last = [...telegram.calls].reverse().find((c) => (c.payload['reply_markup'] as Keyboard | undefined)?.inline_keyboard !== undefined);
      const button = (last?.payload['reply_markup'] as Keyboard | undefined)?.inline_keyboard?.flat().find((b) => b.text.startsWith(step.tapLabel!));
      if (button?.callback_data === undefined) {
        out.push(`  - ${step.do} → ⚠️ no button "${step.tapLabel}" on that screen`);
        continue;
      }
      await bot.handleUpdate(callbackUpdate(button.callback_data, who));
    }
    const d = delta(telegram.calls, from);
    const landed = d.messages.map((m) => `\`${titleOf(m.html)}\``).join(', then ');
    out.push(`  - ${step.do}${landed === '' ? '' : ` → ${landed}`}${d.toast === undefined ? '' : ` (toast: "${placeholders(d.toast)}")`}`);
  }
  for (const n of notes) out.push(`  - ${n}`);
  return out.join('\n');
}
const flows = [
  await flow('First-time start, then watching a wallet', WHO.stranger, [
    { do: 'Send /start', send: '/start' },
    { do: 'Tap 👁 Watch & Alerts', tap: { to: 'watch-menu' } },
    { do: 'Tap 👛 Watch wallet', tap: { to: 'watch-ask' } },
    { do: 'Paste an address as the answer', send: '0xB7854953A71e45D1033B3d619E76d56391291765' },
    { do: 'Tap 👛 Watched wallets', tap: { to: 'wallets' } },
  ]),
  await flow('Connecting', WHO.stranger, [
    { do: 'Send /start', send: '/start' },
    { do: 'Tap 🔐 Trading account', tap: { to: 'account' } },
    { do: 'Tap 🔗 Connect wallet', tap: { to: 'connect-go' } },
    { do: 'Back, then tap 🔑 Enter API key', tap: { to: 'connect-key' } },
  ], [
    'On the web page /link (outside the bot): sign with the wallet that owns the account, or paste an API key. The key never goes through Telegram.',
    'Back in Telegram: /start now shows "🔗 testnet #{account}" and the six buttons.',
  ]),
  await flow('An alert through to a confirmed top-up', WHO.owner, [
    { do: '(PerpGuard sends the alert at the alert distance: see `pushed: manual alert`)', send: '/start' },
    { do: 'Tap 📊 My positions', tap: { to: 'positions' } },
    { do: 'Tap the position', tap: { to: 'position', marketId: dangerAssessment().marketId } },
    { do: 'Tap the first amount', tapLabel: '+' },
    { do: 'Tap ✅ Confirm', tapLabel: '✅' },
  ], ['Two amounts, sized to the alert distance plus 2 and plus 5 points (the first capped at most of the free balance), then 🎛 Custom amount; the alert carries the same two. Each leads to the same confirmation.']),
  await flow('Turning Rescue on and off', WHO.owner, [
    { do: 'Send /start', send: '/start' },
    { do: 'Tap 🛟 Rescue', tap: { to: 'rescue' } },
    { do: 'Tap the position', tap: { to: 'rescue-pos', marketId: dangerAssessment().marketId } },
    { do: 'Tap Change amount', tap: { to: 'rescue-cfg', marketId: dangerAssessment().marketId } },
    { do: 'Pick +250', tap: { to: 'rescue-amt', level: 1 } },
    { do: 'Tap Change limits', tap: { to: 'rescue-limits' } },
    { do: 'Pick 3 times', tap: { to: 'rescue-lim', level: 2 } },
    { do: 'Back to the rule', tap: { to: 'rescue-pos', marketId: dangerAssessment().marketId } },
    { do: 'Tap 🟢 Turn on', tap: { to: 'rescue-on' } },
    { do: 'Tap ⛔ Turn off', tap: { to: 'rescue-stop', marketId: dangerAssessment().marketId } },
  ], ['Inside the alert distance the rule offers "🟢 Turn on · add now" and "🟢 Turn on · next time" instead of one button.']),
  await flow('Kill switch', WHO.owner, [
    { do: 'Send /start', send: '/start' },
    { do: 'Tap 🆘 Kill switch', tap: { to: 'kill' } },
    { do: 'Tap Stop automation only', tap: { to: 'kill-confirm' } },
    { do: 'Tap Yes, stop automation', tap: { to: 'kill-stop' } },
    { do: 'Tap ▶️ Resume automation', tap: { to: 'kill-resume-ask' } },
    { do: 'Tap ▶️ Resume', tap: { to: 'kill-resume' } },
    { do: 'Tap 🆘 Kill switch again', tap: { to: 'kill' } },
    { do: 'Tap 🆘 Stop everything', tap: { to: 'stop-all' } },
    { do: 'Tap 🆘 Yes, stop everything', tap: { to: 'stop-all-go' } },
  ]),
];

// ── screens only a particular state reaches: set the state up, then tap ─────
const M = dangerAssessment().marketId;
const directly = new Map<string, string>();
async function direct(route: Route, who: (typeof WHO)[keyof typeof WHO], setup: readonly (Route | string)[], state: string): Promise<void> {
  const { bot, telegram } = build({ link: true, resolver: true });
  await bot.handleUpdate(messageUpdate('/start', who));
  for (const step of setup) {
    if (typeof step === 'string') await bot.handleUpdate(messageUpdate(step, who));
    else await bot.handleUpdate(callbackUpdate(encodeNav(step), who));
  }
  const from = telegram.calls.length;
  await bot.handleUpdate(callbackUpdate(encodeNav(route), who));
  const d = delta(telegram.calls, from);
  const tier = tierOfRoute(route.to);
  for (const m of d.messages) addScreen(route.to, m.html, m.keyboard, who.label, tier, d.toast).reachedBy.add(`only when ${state}`);
  if (d.messages.length === 0 && d.toast !== undefined) addScreen(`${route.to} (toast only)`, d.toast, undefined, who.label, tier).reachedBy.add(`only when ${state}`);
  directly.set(route.to, state);
}
await direct({ to: 'star', accountId: 4532 }, WHO.stranger, ['/watch 4532'], 'a watched wallet is not yet on the Watchlist (its wallet screen shows ⭐ Add to Watchlist)');
await direct({ to: 'rescue-resume', marketId: M }, WHO.owner, [], 'an Auto rule paused itself (shown here with nothing paused: its refusal)');
await direct({ to: 'close-retry', marketId: M }, WHO.owner, [], 'Stop everything left a position open (its result offers Retry per position)');
await direct({ to: 'close-retry-go', marketId: M }, WHO.owner, [{ to: 'close-retry', marketId: M }], 'Retry was tapped on a position Stop everything left open');
await direct({ to: 'dismiss' }, WHO.owner, [], 'the manual alert is on screen (its Dismiss button)');
await direct({ to: 'watch-id', accountId: 4532 }, WHO.stranger, ['4532'], 'a bare number was sent without being asked, and offered as an account to watch');
await typed(WHO.owner, 'rescue-amt-custom', 'linked testnet', '150', [{ to: 'rescue' }, { to: 'rescue-pos', marketId: M }, { to: 'rescue-cfg', marketId: M }, { to: 'rescue-amt-custom' }].map((r) => encodeNav(r as Route)), 'answer the custom Auto amount question with 150');

// ── completeness: anything a user can reach that the map did not cover ──────
const navSource = readFileSync(join(ROOT, 'apps/bot/src/nav.ts'), 'utf8');
const codeTable = navSource.slice(navSource.indexOf('const CODE'), navSource.indexOf('const NAME_BY_CODE'));
const allRoutes = [...codeTable.matchAll(/^\s+'?([a-z0-9-]+)'?: '[a-z0-9]+',$/gm)].map((m) => m[1]!);
const botSource = readFileSync(join(ROOT, 'apps/bot/src/bot.ts'), 'utf8');
const commands = [...botSource.matchAll(/bot\.command\('([a-z]+)'/g)].map((m) => `/${m[1]}`);
const questionKinds = [...readFileSync(join(ROOT, 'apps/bot/src/questions.ts'), 'utf8').matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1]!);
await typed(WHO.owner, 'typed close percent', 'linked testnet', '40', [encodeNav({ to: 'close-pos', marketId: M }), encodeNav({ to: 'close-pos-pct', marketId: M })], 'answer the Custom % question with 40');
await typed(WHO.owner, 'typed close percent (refused)', 'linked testnet', '150', [encodeNav({ to: 'close-pos', marketId: M }), encodeNav({ to: 'close-pos-pct', marketId: M })], 'answer it with 150 (out of range)');
await typed(WHO.owner, 'typed close percent (all of it)', 'linked testnet', '100', [encodeNav({ to: 'close-pos', marketId: M }), encodeNav({ to: 'close-pos-pct', marketId: M })], 'answer it with 100 (the whole position)');
const coveredQuestions = new Set(['watch-target', 'warning-levels', 'alert-distance', 'rescue-amount', 'close-percent']);
const flowRoutes = new Set(['rescue-amt', 'rescue-limits', 'rescue-lim', 'rescue-on', 'rescue-stop', 'kill-stop', 'kill-resume', 'kill-resume-ask', 'kill-confirm', 'stop-all', 'stop-all-go']);
const gaps: string[] = [];
/**
 * Places in the code that build a button for `route`, counting only those inside
 * a function something else calls: a button built by a screen nobody shows is dead.
 */
const fileCache = new Map<string, string[]>();
const fileLines = (file: string): string[] => fileCache.get(file) ?? (fileCache.set(file, readFileSync(join(ROOT, file), 'utf8').split('\n')), fileCache.get(file)!);
const emitters = (route: string): number =>
  sourceLines.filter((l) => {
    if (l.file.endsWith('nav.ts') || !l.text.includes(`to: '${route}'`)) return false;
    const lines = fileLines(l.file);
    let fn: string | undefined;
    for (let i = l.line - 1; i >= 0 && fn === undefined; i -= 1) fn = /^export function (\w+)\(/.exec(lines[i]!)?.[1];
    if (fn === undefined) return true;
    return sourceLines.some((o) => o.text.includes(`${fn}(`) && !o.text.includes(`function ${fn}(`));
  }).length;
const stateOnly: string[] = [];
const dead: string[] = [];
for (const r of allRoutes) {
  if (reachedRoutes.has(r) || flowRoutes.has(r) || pushedTargets.has(r)) continue;
  if (directly.has(r)) stateOnly.push(`\`${r}\`: ${directly.get(r)}`);
  else if (emitters(r) === 0) dead.push(`\`${r}\`: the bot handles it, but no screen in the code builds a button for it${r === 'connect' ? ' (kept on purpose, so an old "Connect my account" button in a chat still opens)' : ''}`);
  else gaps.push(`Route \`${r}\` is built by the code (${emitters(r)} place(s)) and was not reached by the map.`);
}
for (const k of ['act', 'custom', 'confirm', 'blocked', 'cancel']) {
  if (reachedKinds.has(k)) continue;
  if (k === 'blocked') stateOnly.push('action kind `blocked`: an amount button shown when testnet cannot act on the market; it carries the same label and, tapped, says why (the reason from the venue)');
  else gaps.push(`Action button kind \`${k}\` never appeared on a reachable screen in this world.`);
}
for (const c of commands) if (![...screens.values()].some((s) => s.name.startsWith(c))) gaps.push(`Command \`${c}\` produced no screen.`);
for (const q of new Set(questionKinds)) {
  if (coveredQuestions.has(q)) continue;
  gaps.push(`Typed answer to question \`${q}\` is not driven by the map (its prompt is shown; the answer's screens are not).`);
}
const menu = BOT_MENU_COMMANDS.map((c) => `/${c.command}`);
for (const m of menu) if (!commands.includes(m)) gaps.push(`Menu command \`${m}\` has no handler.`);
const sendSites = readFileSync(join(ROOT, 'apps/backend/src/server.ts'), 'utf8').split('\n').map((l, i) => ({ l, i: i + 1 })).filter((x) => /\.sendMessage\(/.test(x.l));

// ── the duplicates: one sentence on several screens ─────────────────────────
const lineUse = new Map<string, Set<string>>();
for (const s of screens.values()) {
  for (const line of s.text.split('\n').map((l) => l.trim()).filter((l) => l.length >= 30 && l !== 'testnet')) {
    const set = lineUse.get(line) ?? new Set<string>();
    set.add(s.name);
    lineUse.set(line, set);
  }
}
const duplicates = [...lineUse.entries()].filter(([, names]) => names.size > 1).sort((a, b) => b[1].size - a[1].size);

// ── the document ─────────────────────────────────────────────────────────────
const all = [...screens.values()];
const labels = new Map<string, Set<string>>();
for (const s of all) for (const row of s.rows) for (const b of row) (labels.get(b.label) ?? labels.set(b.label, new Set()).get(b.label)!).add(s.name);
const md: string[] = [];
md.push('# PerpGuard bot map', '');
md.push(`Generated by \`pnpm bot:map\` from the real bot (commit ${process.env['GIT_SHA'] ?? 'working tree'}, ${new Date().toISOString().slice(0, 16)} UTC). Telegram and the account's session are faked; every screen was produced by the bot's own code. Live figures are replaced by placeholders: {amount}, {pct}, {account}, {date}, {age}, {address}, {block}, {lev}, {n}. "Source" is the file and line holding the screen's first words; "+N more" means the same words also appear elsewhere in the code.`, '');
md.push('Tiers: **everyone** (any chat), **watch-only** (the public watch tier: read-only, no account), **linked testnet** (a chat linked to a testnet account; the only tier that can act).', '');
md.push('## 1. Index', '');
md.push('### Commands', '', ...[...new Set([...commands, ...menu])].sort().map((c) => `- \`${c}\``), '');
md.push('### Screens', '', ...[...new Set(all.map((s) => s.name))].sort((a, b) => a.localeCompare(b)).map((n) => `- ${n}`), '');
md.push('### Button labels', '', ...[...labels.keys()].sort((a, b) => a.localeCompare(b)).map((l) => `- ${l}`), '');
md.push('## 2. Screens', '');
for (const group of [...new Set(all.map((s) => s.group))].sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]))) {
  md.push(`### ${group}`, '');
  for (const s of all.filter((x) => x.group === group).sort((a, b) => a.name.localeCompare(b.name))) {
    md.push(`#### ${s.name}`, '');
    md.push(`- Tier: **${s.tier}** · seen as: ${[...s.seenAs].join(', ')}`);
    md.push(`- Source: ${s.source === undefined ? '⚠️ not found by its words (built from parts; search for a phrase)' : `\`${s.source}\``}`);
    if (s.reachedBy.size > 0) md.push(`- Reached by: ${[...s.reachedBy].slice(0, 4).join('; ')}${s.reachedBy.size > 4 ? `; and ${s.reachedBy.size - 4} more` : ''}`);
    if (s.toasts.size > 0) md.push(`- Toast on tap: ${[...s.toasts].map((t) => `"${placeholders(t)}"`).join('; ')}`);
    md.push('', '```text', s.text, '```', '');
    if (s.rows.length === 0) md.push('_No buttons._', '');
    s.rows.forEach((row, i) => {
      md.push(`- Row ${i + 1}:`);
      for (const b of row) md.push(`  - [${b.label}] → ${b.target}${b.source === undefined ? '' : ` · \`${b.source}\``}`);
    });
    md.push('');
  }
}
md.push('## 3. Flows', '', ...flows, '');
md.push('## 4. Copy that appears on more than one screen', '', 'Change one of these and every screen listed changes with it (or, where the code repeats the words, must be changed in each place).', '');
for (const [line, names] of duplicates) md.push(`- "${line}"`, ...[...names].sort().map((n) => `  - ${n}`));
md.push('', '### Button labels used on more than one screen', '');
for (const [label, names] of [...labels.entries()].filter(([, n]) => n.size > 1).sort((a, b) => b[1].size - a[1].size)) md.push(`- [${label}] on ${names.size} screens`);
md.push('', '## 5. Reachable but not mapped', '');
md.push(gaps.length === 0 ? '**Nothing.** Every route, command, action kind and question kind the code defines is in this map, by tapping from /start, in a flow, on a pushed message, or set up in the state that shows it (below).' : 'Each of these is something the code can show a user that the map did not reach. Each is a bug:', '');
for (const g of gaps) md.push(`- ${g}`);
md.push('', '### Mapped, but only in a particular state', '', 'Not reachable from a fresh /start; set up in that state and tapped, and their screens are in section 2.', '');
for (const g of stateOnly) md.push(`- ${g}`);
md.push('', '### Dead: handled, but nothing a user can see leads there', '');
md.push(dead.length === 0 ? 'None.' : 'Code a user cannot reach. Candidates for deletion:');
for (const g of dead) md.push(`- ${g}`);
md.push('', '### Messages the server sends directly (checked against section 2, group 10)', '');
for (const s of sendSites) md.push(`- \`apps/backend/src/server.ts:${s.i}\`: ${s.l.trim().slice(0, 140)}`);
md.push('');

const doc = md.join('\n');
writeFileSync(OUT, doc);
console.log(doc);
console.error(`\nwrote ${OUT}: ${all.length} screens, ${labels.size} button labels, ${commands.length} commands, ${gaps.length} gap(s)`);
process.exit(0);
