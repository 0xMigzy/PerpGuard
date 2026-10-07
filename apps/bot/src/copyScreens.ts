/**
 * 🔁 WHAT IF I'D COPIED? (Copy Trading, Half A; owner, 7 Oct 2026). One
 * trader's last 30 days replayed onto an account of the reader's size, from
 * indexed data. NOTHING IS SENT: the screen says so, and it carries no action.
 *
 * The bot shows the totals, why things were skipped, and the latest copied
 * trades; the web page (`/copy/<id>`) lists every one. The limits are stated
 * on the screen every time: prices and timing differ, past results predict
 * nothing, sizes are the leader's peak, fees are the least it would cost.
 */
import { esc } from '@perpguard/backend/alerts/plain';
import { ausdText, type ReplayResult, type ReplayTrade, type SkipReason } from '@perpguard/backend/copy/replay';
import type { Button, Screen } from './screens.ts';
import type { Route } from './nav.ts';

/** Where the follower's size came from, said on the screen. */
export type CopySize = { readonly kind: 'linked'; readonly accountId: number; readonly network: string } | { readonly kind: 'default' };

export const DEFAULT_COPY_SIZE_AUSD = 1_000;
const SHOWN = 6;

const SKIP_LABEL: Readonly<Record<SkipReason, string>> = {
  'open-at-start': 'already open when the 30 days began',
  'not-listed': 'market not on testnet',
  'too-small': 'too small at your size',
  'no-balance': 'not enough free balance at the time',
  leverage: "leverage above testnet's maximum",
  'no-size': 'no size in the index',
  'no-entry': 'no entry price in the index',
  'leader-no-equity': 'leader had no equity on record',
};

const day = (ms: number): string => new Date(ms).toISOString().slice(5, 10).replace('-', '/');
const signed = (cns: bigint, d: number): string => {
  const text = ausdText(cns, 'floor', d);
  return cns > 0n ? `+${text}` : text;
};

function tradeLine(t: ReplayTrade, d: number): string {
  const c = t.copy;
  if (c.kind !== 'copied') return '';
  const what = `${day(t.openedAtMs)} ${esc(t.symbol)} ${t.side}`;
  const result = c.resultCNS === undefined ? 'no price now' : `<b>${signed(c.resultCNS, d)}</b>`;
  const tag = t.status === 'forced' ? ' · 💥 liquidated' : t.status === 'open' ? ' · still open (at today’s price)' : '';
  return `• ${what} · margin ${ausdText(c.marginCNS, 'ceil', d)} → ${result}${tag}`;
}

export function copyReplayScreen(input: { readonly result: ReplayResult | { readonly kind: 'unknown-account'; readonly accountId: number }; readonly size: CopySize; readonly webUrl: string | undefined; readonly back: Route; readonly ageMs: number }): Screen {
  const r = input.result;
  const back: Button[] = [{ text: '← Back', route: input.back }];
  const head = `🔁 <b>WHAT IF YOU'D COPIED #${r.accountId}?</b> · last 30 days`;
  if (r.kind === 'unknown-account') return { html: `${head}\n\nThe index has no account #${r.accountId}.`, buttons: [back] };
  if (r.kind === 'no-follower-equity') return { html: `${head}\n\nYour account holds nothing to copy with, so there is nothing to scale to.`, buttons: [back] };
  if (r.kind === 'too-busy') {
    return {
      html: [
        head,
        '',
        `#${r.accountId} opened <b>${r.openedInWindow.toLocaleString('en-US')} positions</b> in 30 days, more than ${r.cap.toLocaleString('en-US')}. That is a bot's pace: a copy could not keep up, so I do not replay it at all rather than show half of it.`,
      ].join('\n'),
      buttons: [back],
    };
  }

  const d = r.collateralDecimals;
  const t = r.totals;
  const sizeLine = input.size.kind === 'linked'
    ? `Sized to your account #${input.size.accountId} on ${esc(input.size.network)}: <b>${ausdText(r.followerStartCNS, 'floor', d)}</b> (free balance plus margin in positions).`
    : `Sized to an account of <b>${ausdText(r.followerStartCNS, 'floor', d)}</b>. Link your account and this uses yours.`;
  const lines = [
    head,
    '<i>A replay from indexed data. Nothing was or will be sent.</i>',
    '',
    sizeLine,
    `Each copy is the leader's position scaled by your equity over theirs at that moment (theirs was <b>${ausdText(r.leaderStartCNS, 'floor', d)}</b> when the 30 days began).`,
    '',
    `📊 <b>${signed(t.closedResultCNS, d)}</b> on closed copies, after <b>${ausdText(t.feesCNS, 'ceil', d)}</b> of fees`,
  ];
  if (t.openEstimateCNS !== 0n) lines.push(`   ${signed(t.openEstimateCNS, d)} more on copies still open, at today's price (not realised)`);
  lines.push(
    `   ${ausdText(r.followerStartCNS, 'floor', d)} → <b>${ausdText(t.followerEndEquityCNS, 'floor', d)}</b>`,
    `   ${t.copied} copied · ${t.wins} won, ${t.losses} lost${t.forcedExits > 0 ? ` · 💥 ${t.forcedExits} liquidated` : ''}`,
    `   Lowest free balance along the way: ${ausdText(t.lowestFreeCNS, 'floor', d)}`,
  );
  if (t.skipped > 0) {
    lines.push('', `⏭ <b>${t.skipped} skipped</b>`);
    for (const [reason, n] of Object.entries(t.skippedBy) as Array<[SkipReason, number]>) {
      const which = reason === 'not-listed' ? `: ${t.notListed.map((x) => `${esc(x.symbol)} ×${x.count}`).join(', ')}` : '';
      lines.push(`   ${n} · ${SKIP_LABEL[reason]}${which}`);
    }
  }
  const copied = r.trades.filter((x) => x.copy.kind === 'copied');
  if (copied.length > 0) {
    const latest = copied.slice(-SHOWN).reverse();
    lines.push('', `<b>Latest ${latest.length} of ${copied.length}</b>`, ...latest.map((x) => tradeLine(x, d)));
  }
  lines.push(
    '',
    `<i>Limits: prices and timing differ (a copy fills after the leader, at ${esc(r.actingNetwork)}'s prices). Sizes are each position's peak, because the index keeps a position's open and close but not the adds and reduces between. Fees are ${esc(r.actingNetwork)}'s taker rate on opening and closing, the least it would cost. The leader's own result here is before fees. Past results do not predict future returns.</i>`,
  );
  if (input.ageMs > 45_000) lines.push(`<i>Computed ${Math.round(input.ageMs / 1000)} s ago.</i>`);
  const buttons: Button[][] = [];
  if (input.webUrl !== undefined) {
    const size = Number(r.followerStartCNS / 10n ** BigInt(d));
    buttons.push([{ text: '📋 Every trade, on the site', url: `${input.webUrl.replace(/\/$/, '')}/copy/${r.accountId}?size=${size}` }]);
  }
  buttons.push(back);
  return { html: lines.join('\n'), buttons };
}
