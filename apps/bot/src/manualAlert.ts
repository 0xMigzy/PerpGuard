/**
 * 🔔 THE MANUAL ALERT (Part 2, owner, 7 Oct 2026): the default, on for every
 * linked account, nothing to arm. When a position reaches the account's alert
 * distance, ONE message: the position, its distance, the free balance, and
 * the amounts to add. Margin moves only when the person taps an amount AND
 * confirms it (the same two-step confirm as Add Margin: a mis-tap on a phone
 * notification sends nothing). Nothing is sent on PerpGuard's own initiative.
 *
 * When AUTO top-up is armed on the position, the same crossing says it is
 * ADDING, not asking, with a one-tap Turn off; when Auto is armed but held
 * (cooldown, balance, kill switch), it says why and offers the amounts.
 *
 * The backend decides WHEN (`apps/backend/src/manual/alerts.ts`); this file
 * says it and mints the buttons, through the same pending-action store and
 * pricing as the Add Margin screen.
 */
import type { Api } from 'grammy';
import type { MarketRiskConfig } from '@perpguard/shared';
import type { AlertAction, AlertConfig } from '@perpguard/backend/alerts';
import { distance, esc, held, money, positionName, signedPnl, withBadge } from '@perpguard/backend/alerts/plain';
import type { RiskAssessment } from '@perpguard/backend/risk';
import { distanceLabel } from '@perpguard/backend/manual/distance';
import { ADD_MARGIN_PRESETS_AUSD } from './account.ts';
import type { FreeBalanceReading } from './balance.ts';
import { encodeCallback, type CallbackKind } from './callback.ts';
import { customAction } from './custom.ts';
import type { LinkStore } from './links.ts';
import { encodeNav } from './nav.ts';
import type { PendingActionStore } from './actions.ts';
import type { SessionRouter } from './sessions.ts';

/** What Auto top-up will do at this crossing, as the rescue engine judged it. */
export type AutoNow =
  | { readonly kind: 'off' }
  | { readonly kind: 'adding'; readonly amountCNS: bigint; readonly used: number; readonly max: number }
  | { readonly kind: 'waiting'; readonly why: string };

export interface ManualAlertInput {
  readonly accountId: number;
  readonly assessment: RiskAssessment;
  /** The account's alert distance, percent. */
  readonly alertPct: number;
  readonly auto: AutoNow;
}

export interface ManualAlertDeps {
  readonly api: Pick<Api, 'sendMessage'>;
  readonly store: PendingActionStore;
  readonly links: Pick<LinkStore, 'byAccountId'>;
  readonly sessions: SessionRouter;
  readonly configs: ReadonlyMap<number, MarketRiskConfig>;
  readonly alerts: Pick<AlertConfig, 'bufferDecimals'>;
  /** The acting network, for the badge on the alert (it offers actions). */
  readonly network?: string | undefined;
}

type Key = { readonly text: string; readonly callback_data: string };

/** The message text, for one account. Pure. */
export function manualAlertText(input: ManualAlertInput, free: FreeBalanceReading, market: MarketRiskConfig | undefined): string {
  const a = input.assessment;
  const d = market?.collateralDecimals ?? 6;
  const lines: string[] = [];
  if (input.auto.kind === 'adding') {
    lines.push(
      `🤖 <b>AUTO TOP-UP</b> · ${positionName(a)} is <b>${distance(a.liqBufferPct)}</b> (your alert: ${distanceLabel(input.alertPct)})`,
      '',
      `Adding ${money(input.auto.amountCNS, 'ceil', d)} now (top-up ${input.auto.used + 1} of ${input.auto.max}). You get the result when it lands, checked against the position itself.`,
    );
    return lines.join('\n');
  }
  lines.push(`🔔 <b>${positionName(a)} is ${distance(a.liqBufferPct)}</b> · your alert: ${distanceLabel(input.alertPct)}`, '');
  if (a.marginCNS !== undefined) lines.push(`Margin ${held(a.marginCNS, d)} · P&amp;L <b>${esc(signedPnl(a.metrics.unrealisedPnlCNS, d))}</b>`);
  lines.push(free.known ? `Free balance: at least ${held(free.floorCNS, d)}` : `Free balance: not known right now (${esc(free.reason)})`);
  if (input.auto.kind === 'waiting') lines.push('', `🤖 Auto top-up is on for this position but is not adding right now: ${esc(input.auto.why)}.`);
  lines.push('', 'Add margin? Tap an amount, then confirm. Nothing is sent until you do.');
  return lines.join('\n');
}

export function createManualAlertSender(deps: ManualAlertDeps): (input: ManualAlertInput) => Promise<void> {
  return async (input) => {
    const a = input.assessment;
    const account = deps.sessions.forAccount(input.accountId);
    const market = deps.configs.get(a.marketId);
    const free: FreeBalanceReading = account?.balance.freeBalance() ?? { known: false, reason: 'the account is not connected right now' };
    // THE NETWORK ON EVERY ACTION SCREEN: this message offers actions.
    const text = withBadge(manualAlertText(input, free, market), deps.network);
    const nav = (to: Parameters<typeof encodeNav>[0]): string => encodeNav(to, { fresh: true });

    // Asked of the ACTING venue BY MARKET ID before any amount is offered as live.
    let actionable = false;
    try {
      actionable = account !== undefined && (await account.executor.availability({ marketId: a.marketId, symbol: a.symbol })).actionable;
    } catch {
      actionable = false;
    }

    for (const link of deps.links.byAccountId(input.accountId)) {
      const rows: Key[][] = [];
      if (input.auto.kind === 'adding') {
        rows.push([
          { text: '📊 View position', callback_data: nav({ to: 'position', marketId: a.marketId }) },
          { text: '⛔ Turn off auto', callback_data: nav({ to: 'rescue-stop', marketId: a.marketId }) },
        ]);
      } else if (account !== undefined && market !== undefined && a.positionId !== undefined) {
        // Minted PER PERSON: a token is issued to one Telegram user and refused to anyone else.
        const mint = (action: AlertAction, kind: CallbackKind): string =>
          encodeCallback({ kind, token: deps.store.put({ userId: link.userId, telegramUserId: link.telegramUserId, action }).token, marketId: action.marketId, amountCNS: action.amountCNS });
        const unit = 10n ** BigInt(market.collateralDecimals);
        const amounts: Key[] = [];
        for (const ausd of ADD_MARGIN_PRESETS_AUSD) {
          // Priced by the engine NOW, so the confirmation's after-figures are this position's.
          const projected = account.view.projectAddMargin(a.marketId, BigInt(ausd) * unit);
          if (!projected.ok) continue;
          const action = { ...customAction(projected.projection, market, a.positionId, deps.alerts.bufferDecimals, a.liqBufferPct), accountId: input.accountId };
          amounts.push({ text: `+${ausd.toLocaleString('en-US')}`, callback_data: mint(action, actionable ? 'act' : 'blocked') });
        }
        if (amounts.length > 0) rows.push(amounts);
        const custom: AlertAction = { type: 'add-margin', intent: 'custom', marketId: a.marketId, symbol: a.symbol, positionId: a.positionId, accountId: input.accountId, amountCNS: 0n, label: 'Custom amount' };
        rows.push([
          { text: '✏️ Custom', callback_data: mint(custom, actionable ? 'custom' : 'blocked') },
          { text: '📊 View position', callback_data: nav({ to: 'position', marketId: a.marketId }) },
        ]);
        rows.push([{ text: 'Dismiss', callback_data: encodeNav({ to: 'dismiss' }) }]);
      } else {
        rows.push([{ text: '📊 View position', callback_data: nav({ to: 'position', marketId: a.marketId }) }]);
      }
      await deps.api.sendMessage(link.chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: rows } });
    }
  };
}
