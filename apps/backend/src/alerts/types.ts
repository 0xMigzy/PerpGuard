/**
 * Ports and shapes for the alerts layer.
 *
 * Two injected ports, so everything below tests without Telegram and without a
 * database: {@link AlertTransport} sends, {@link AlertLog} records. Neither is
 * venue-specific and neither knows what a chat id is.
 *
 * The layer splits three ways on purpose:
 *   rules.ts   decides WHETHER to say something   (pure)
 *   render.ts  decides WHAT it says               (pure)
 *   engine.ts  does the sending and recording     (the only I/O)
 */
import type { MarketRiskConfig, Unsubscribe } from '@perpguard/shared';
import type { BlindState, RiskState, Severity, WatchedScope } from '../risk/types.ts';

export type { Unsubscribe, WatchedScope };

/**
 * What a recipient may DO with an alert, and the one place that is decided.
 *
 *   act    the linked owner: top-up buttons, custom amount, confirmation.
 *   watch  a public watcher: the same words, NO KEYBOARD AT ALL. A watcher
 *          sees a position in danger and can do nothing about it, and the bot's
 *          authorisation gate refuses any action payload from an unlinked chat
 *          regardless of what a message carried.
 */
export type AlertRights = 'act' | 'watch';

/**
 * Who one copy of an alert goes to.
 *
 * The engine decides ONCE per position whether to speak — cooldown, dwell and
 * escalation are per position, never per recipient — and then fans the message
 * out to this list, each copy shaped by its rights. `userId` is what the alert
 * log records; `chatId` is set for watchers, whose address is the chat itself
 * rather than a linked app user.
 */
export interface AlertRecipient {
  readonly userId: string;
  readonly rights: AlertRights;
  readonly chatId?: number;
}

/**
 * What kind of thing an alert says, which is not the same question as the risk
 * state it came from.
 *
 * It exists so one predicate — {@link isReassuring} — can answer the only
 * question the stale-price contract cares about. Keying that off `RiskState`
 * instead would mean every new state silently defaulting to "not reassuring",
 * and the one that defaulted wrongly would be the bug that slipped an all-clear
 * through on a frozen price.
 */
export type AlertKind =
  | 'past-liquidation'
  | 'danger'
  | 'watch'
  | 'recovered'
  | 'feed-down'
  | 'positions-untrusted';

/**
 * Whether this kind of message would REASSURE the reader.
 *
 * Only `recovered` does. The two blind kinds are explicitly not reassuring even
 * though they carry no severity: they say we cannot see, which is the opposite
 * of an all-clear.
 *
 * See the contract on `RiskAssessment.heldOnStalePrice`. While that flag is set
 * no reassuring message may be produced at all, and `rules.ts` both gates on
 * this and asserts on it.
 */
export function isReassuring(kind: AlertKind): boolean {
  return kind === 'recovered';
}

/** The only action an alert offers today. Closing is the actions layer's job. */
/**
 * What a button does. Alerts offer only top-ups; the bot's position screen
 * also offers a reduce and a close, through the same token, confirmation and
 * reconciliation path.
 */
export type AlertActionType = 'add-margin' | 'reduce-position' | 'close-position';

/**
 * Which top-up this is.
 *
 * `clear-danger` is the cheap one and reaches the danger exit threshold. It is
 * NOT the safe option and nothing may render it as one.
 *
 * `custom` is an amount THE USER PICKED, so it reaches whatever it reaches and
 * has no target to name. It is never produced by this layer — an alert offers
 * only the two computed options — and exists here because the action it becomes
 * is the same shape, goes through the same confirmation and lands in the same
 * `action_log`. A third intent rather than a flag on the other two, because
 * "which of the two thresholds did this aim at" has no answer for it.
 */
export type AlertActionIntent = 'clear-danger' | 'to-safe' | 'custom' | 'reduce' | 'close';

/**
 * Structured action data, for the bot to build a button from.
 *
 * The bot must never re-derive an amount from the message text, and never
 * recompute one from a position: it sends `amountCNS` verbatim. That is why the
 * amount here is the CEILED figure — exactly the number the text showed the user.
 * See the rounding rule in CLAUDE.md.
 */
export interface AlertAction {
  /**
   * The account the position belongs to. Carried so the bot can check, at
   * the moment of the tap, that the tapping chat is linked to THIS account
   * and refuse otherwise — the request-time rule, not a link-time one.
   */
  readonly accountId?: number;
  readonly type: AlertActionType;
  readonly intent: AlertActionIntent;
  readonly marketId: number;
  readonly symbol: string;
  /** The venue handle to address the action to. Undefined when unknown. */
  readonly positionId: number | undefined;
  /** AUSD micros to send, matching the rendered text exactly. 0 for a reduce or a close. */
  readonly amountCNS: bigint;
  /** Lots to close, for a reduce. In the market's own lot scaling. */
  readonly sizeLNS?: bigint;
  /**
   * Where a top-up lands, for the confirmation and outcome screens to quote
   * without parsing `label`: the closing price and the room to fall after
   * the EXACT unrounded amount, and the room to fall before it.
   */
  readonly resultingLiquidationPricePNS?: bigint;
  readonly resultingBufferPct?: number;
  readonly fromBufferPct?: number;
  /** The rendered line this action came from, so the button can reuse it. */
  readonly label: string;
}

export interface AlertMessage {
  /** The linked account this is about, when it is a session's own position. */
  readonly accountId?: number;
  /** Present when this is about a WATCHED account. See `WatchedScope`. */
  readonly watch?: WatchedScope;
  readonly kind: AlertKind;
  readonly state: RiskState;
  readonly previousState: RiskState | undefined;
  readonly marketId: number;
  readonly symbol: string;
  readonly positionId: number | undefined;
  readonly title: string;
  /** The body, one line per element. `text` is these joined, title included. */
  readonly lines: readonly string[];
  /**
   * The same alert in Telegram HTML, in the bot screens' plain voice. Present
   * only on a WATCHED assessment's message, where the transport sends it with
   * parse mode HTML. `text` stays the plain record that `alert_log` keeps.
   */
  readonly html?: string;
  readonly text: string;
  readonly actions: readonly AlertAction[];
  readonly atMs: number;
}

/**
 * What a transport reports back.
 *
 * `retryable: false` STOPS the retry loop. A transport that knows the failure is
 * permanent — a blocked bot, an unknown chat — says so rather than letting three
 * attempts burn against something that cannot succeed.
 */
export interface DeliveryResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly retryable?: boolean;
  /**
   * Deliberately not sent (the startup gate dropped a blindness alert about
   * the process starting). Logged; neither a delivery nor a failure.
   */
  readonly suppressed?: boolean;
}

export interface AlertTransport {
  send(recipient: AlertRecipient, message: AlertMessage): Promise<DeliveryResult>;
}

/** How an attempt sequence ended. There is no `suppressed`: see {@link AlertLog}. */
export type DeliveryOutcome = 'delivered' | 'failed';

export interface AlertLogEntry {
  /**
   * Identifies this alert for deduplication across restarts.
   *
   * Market, state and the assessment's own timestamp. Not a cryptographic key —
   * it exists so a human reading the table can tell two alerts apart, and so a
   * re-delivery of the same assessment is recognisable.
   */
  /** The watched account, when this alert was about one. Absent for the owner's own. */
  readonly accountId?: number;
  readonly alertKey: string;
  readonly userId: string;
  readonly marketId: number;
  readonly symbol: string;
  readonly kind: AlertKind;
  readonly state: RiskState;
  readonly previousState: RiskState | undefined;
  readonly text: string;
  readonly actions: readonly AlertAction[];
  /** How many send attempts were made. At least 1. */
  readonly attempts: number;
  readonly outcome: DeliveryOutcome;
  /** The last failure reason. Present whenever any attempt failed. */
  readonly lastError: string | undefined;
  readonly createdAtMs: number;
  /** When it landed. Undefined on `failed`. */
  readonly deliveredAtMs: number | undefined;
}

/**
 * Where delivery outcomes are recorded.
 *
 * ONE ROW PER ATTEMPT SEQUENCE, not per attempt and not per decision. A
 * suppressed alert writes nothing: suppression is the normal case — cooldown
 * alone suppresses most ticks — and a row for each would bury the rows that
 * matter under thousands that say "working as intended".
 */
export interface AlertLog {
  record(entry: AlertLogEntry): Promise<void>;
}

/**
 * Cooldown, retry and formatting precision.
 *
 * COOLDOWN IS PER POSITION PER SEVERITY, and escalation bypasses it entirely —
 * see `rules.ts`. The default is 15 minutes for every severity; they are separate
 * keys so DANGER can be made more talkative than WATCH without touching code.
 */
export interface AlertConfig {
  readonly cooldownMs: Readonly<Record<Severity, number>>;
  /** Total send attempts, including the first. */
  readonly maxAttempts: number;
  /**
   * Backoff before attempt n+1, indexed from 0. Shorter than the array means the
   * last value repeats, so a longer `maxAttempts` needs no matching edit here.
   */
  readonly backoffMs: readonly number[];
  /** Decimal places on a rendered buffer percentage. */
  readonly bufferDecimals: number;
  /**
   * Decimal places on a rendered AUSD top-up.
   *
   * 0 by default: whole AUSD is what a trader thinks in, and the figure is
   * CEILED to it, never rounded. Raising this shows more precision and ceils to
   * that instead. It is capped by the market's own `collateralDecimals`, past
   * which there is no more precision to show.
   */
  readonly ausdDisplayDecimals: number;
}

const FIFTEEN_MINUTES_MS = 15 * 60_000;

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  cooldownMs: {
    SAFE: FIFTEEN_MINUTES_MS,
    WATCH: FIFTEEN_MINUTES_MS,
    DANGER: FIFTEEN_MINUTES_MS,
    PAST_LIQUIDATION: FIFTEEN_MINUTES_MS,
  },
  maxAttempts: 3,
  backoffMs: [1_000, 4_000],
  bufferDecimals: 1,
  ausdDisplayDecimals: 0,
};

/** Everything `decide` needs that is not the event itself. */
export interface AlertRuleContext {
  readonly alerts: AlertConfig;
  /**
   * The market this position is on, for its OWN scaling.
   *
   * Every price is rendered at this market's `priceDecimals` and every amount at
   * its `collateralDecimals`. Nothing in `render.ts` hard-codes a decimal count —
   * that is the same class of bug as hard-coding a maintenance margin ratio, and
   * it would quietly misprice every market that is not BTC.
   */
  readonly market: MarketRiskConfig;
}

/**
 * What we have already said about one position.
 *
 * IN MEMORY, NOT IN THE DATABASE, deliberately. A restart forgets it and may
 * re-alert a position once; the alternative failure — a cooldown surviving a
 * restart and swallowing the first DANGER after one — is far worse. Erring
 * towards one duplicate warning is the right direction. Recorded as a known
 * limitation in `docs/evidence.md`.
 *
 * Immutable: `decide` returns the next one rather than mutating this, which is
 * what keeps it a pure function.
 */
export interface AlertHistory {
  readonly marketId: number;
  /** When an alert of each severity was last SENT. Missing means never. */
  readonly lastSentAtMs: Readonly<Partial<Record<Severity, number>>>;
  /** Severity of the last alert actually sent, for the escalation comparison. */
  readonly lastAlertedSeverity: Severity | undefined;
  /** WATCH has been announced for the CURRENT stay in WATCH. */
  readonly watchAlertedThisEntry: boolean;
  /**
   * Blind causes already announced for the current outage.
   *
   * A list rather than a flag because the two causes are different problems with
   * different fixes: if the feed drops and then the position set also goes bad,
   * the second is worth saying even though we were already blind.
   */
  readonly announcedOutages: readonly BlindState[];
}

export function emptyHistory(marketId: number): AlertHistory {
  return {
    marketId,
    lastSentAtMs: {},
    lastAlertedSeverity: undefined,
    watchAlertedThisEntry: false,
    announcedOutages: [],
  };
}

export interface AlertDecision {
  readonly send: boolean;
  /** Present exactly when `send` is true. */
  readonly message: AlertMessage | undefined;
  /** Why nothing is being sent. Present exactly when `send` is false. */
  readonly suppressedReason: string | undefined;
  /**
   * The history to store, whether or not anything was sent.
   *
   * RETURNED EVEN WHEN SUPPRESSING, because suppression still changes what we
   * know: a tick that leaves WATCH resets the once-per-entry latch, and a tick
   * that returns to a real severity clears the outage latches. Dropping the
   * history on a suppressed tick would leave those latches stuck and silence the
   * next real alert.
   */
  readonly history: AlertHistory;
}
