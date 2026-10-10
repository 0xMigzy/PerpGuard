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
import { esc, fromLiquidation, held, money, positionName, withBadge } from '@perpguard/backend/alerts/plain';
import type { RiskAssessment } from '@perpguard/backend/risk';
import { amountButton, bandDot, suggestionLines } from './account.ts';
import type { FreeBalanceReading } from './balance.ts';
import { encodeCallback, type CallbackKind } from './callback.ts';
import { pricedOffers, type PricedOffers } from './offers.ts';
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
  /** Held back from an account's free balance: Rescue in flight and the largest armed "minimum remaining". */
  readonly reserved?: ((accountId: number) => bigint) | undefined;
}

type Key = { readonly text: string; readonly callback_data: string };

/**
 * The message text, for one account. Pure. THE ALERT CARRIES THE ACTION
 * (owner, 8 Oct 2026): the distance, the margin and the free balance in two
 * lines, so a position can be saved from the notification without opening
 * the bot.
 */
export function manualAlertText(input: ManualAlertInput, free: FreeBalanceReading, market: MarketRiskConfig | undefined): string {
  const a = input.assessment;
  const d = market?.collateralDecimals ?? 6;
  const head = `${bandDot(a)} <b>${positionName(a)} is ${fromLiquidation(a.liqBufferPct)}</b>`;
  if (input.auto.kind === 'adding') {
    return [head, `🛟 Rescue is adding ${money(input.auto.amountCNS, 'ceil', d)} now — top-up ${input.auto.used + 1} of ${input.auto.max}. I'll tell you when it lands.`].join('\n');
  }
  const lines = [head];
  const margin = a.marginCNS === undefined ? undefined : `Margin ${held(a.marginCNS, d)}`;
  const spare = free.known ? `${held(free.floorCNS, d)} free` : 'free balance unknown';
  lines.push([margin, spare].filter((x) => x !== undefined).join(' · '));
  if (input.auto.kind === 'waiting') lines.push(`🛟 Rescue is on but not adding: ${esc(input.auto.why)}.`);
  return lines.join('\n');
}

export function createManualAlertSender(deps: ManualAlertDeps): (input: ManualAlertInput) => Promise<void> {
  return async (input) => {
    const a = input.assessment;
    const account = deps.sessions.forAccount(input.accountId);
    const market = deps.configs.get(a.marketId);
    const free: FreeBalanceReading = account?.balance.freeBalance() ?? { known: false, reason: 'the account is not connected right now' };
    // THE NETWORK ON EVERY ACTION SCREEN: this message offers actions.
    // SIZED TO DISTANCES (owner, 9 Oct 2026; `suggestedAmounts.ts`): priced once, shown to every linked chat.
    const priced: PricedOffers | undefined =
      input.auto.kind !== 'adding' && account !== undefined && market !== undefined && a.positionId !== undefined
        ? pricedOffers({ view: account.view, assessment: a, market, alertPct: input.alertPct, free, reservedCNS: deps.reserved?.(input.accountId), bufferDecimals: deps.alerts.bufferDecimals })
        : undefined;
    // THE ALERT IS SHORT (owner, 9 Oct 2026): network, headline, margin and free balance, then buttons. Each
    // top-up's button says what it buys and what it leaves free. The one sentence is for a balance that buys
    // almost nothing: then there is no top-up to carry it, so it is said.
    const said = priced === undefined || market === undefined ? [] : suggestionLines(priced.suggestions, market.collateralDecimals);
    const text = withBadge([manualAlertText(input, free, market), ...said].join('\n'), deps.network);
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
          { text: '📊 View / close position', callback_data: nav({ to: 'position', marketId: a.marketId }) },
          { text: '⛔ Turn off', callback_data: nav({ to: 'rescue-stop', marketId: a.marketId }) },
        ]);
      } else if (account !== undefined && market !== undefined && a.positionId !== undefined) {
        // Minted PER PERSON: a token is issued to one Telegram user and refused to anyone else.
        const mint = (action: AlertAction, kind: CallbackKind): string =>
          encodeCallback({ kind, token: deps.store.put({ userId: link.userId, telegramUserId: link.telegramUserId, action }).token, marketId: action.marketId, amountCNS: action.amountCNS });
        // UP TO TWO TOP-UPS THAT FIT THE FREE BALANCE (owner, 10 Oct 2026), one to a row. Each priced by the
        // engine, so the button shows the distance it buys and the confirmation's after-figures are this position's.
        for (const { amount, action } of priced?.offers ?? []) {
          const owned = { ...action, accountId: input.accountId };
          rows.push([{ text: amountButton(amount.amountCNS, market.collateralDecimals, owned.resultingBufferPct, amount.freeAfterCNS), callback_data: mint(owned, actionable ? 'act' : 'blocked') }]);
        }
        const custom: AlertAction = { type: 'add-margin', intent: 'custom', marketId: a.marketId, symbol: a.symbol, positionId: a.positionId, accountId: input.accountId, amountCNS: 0n, label: 'Custom amount' };
        rows.push([
          { text: '🎛 Custom amount', callback_data: mint(custom, actionable ? 'custom' : 'blocked') },
          { text: 'Dismiss', callback_data: encodeNav({ to: 'dismiss' }) },
        ]);
        // ALWAYS on the alert, top-ups or none (owner, 10 Oct 2026): closing, in part or in full, is from the position's screen.
        rows.push([{ text: '📊 View / close position', callback_data: nav({ to: 'position', marketId: a.marketId }) }]);
      } else {
        rows.push([{ text: '📊 View / close position', callback_data: nav({ to: 'position', marketId: a.marketId }) }]);
      }
      await deps.api.sendMessage(link.chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: rows } });
    }
  };
}
