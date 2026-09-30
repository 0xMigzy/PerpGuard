/**
 * What the Protect page receives. JSON-SAFE BY CONSTRUCTION: every bigint the
 * backend holds is either a decimal string (exact money) or a display number,
 * and nothing here is a class. The web imports this file for TYPES only.
 *
 * Two rules the shapes enforce rather than document:
 *
 *   THE VENUE'S WORD AND THE POSITION'S WORD ARE SEPARATE FIELDS. An outcome
 *   carries `reported` (what the venue said) and `reconciliation` (what the
 *   position showed), and the page renders both when they disagree — the sr 32
 *   case, where the venue says Failed while the margin is in, is the clearest
 *   demonstration of why the tool is trustworthy and must stay visible.
 *
 *   A NEGATIVE BUFFER SHIPS WITH ITS WORDS. `liqBufferPct` is signed and
 *   `bufferText` is the sentence the alerts renderer wrote for it, so a page
 *   has "past liquidation" ready and no reason to print a negative percentage.
 */
import type {
  ActionAvailability,
  FeedHealth,
  NetworkName,
  PositionSourceStatus,
  Side,
} from '@perpguard/shared';
import type { RiskState, RiskThresholds } from '../../risk/types.ts';
import type { RefusalCode, ReconciledVerdict, WatchedField } from '../../actions/types.ts';

export type { RiskState, RiskThresholds, ActionAvailability, FeedHealth, PositionSourceStatus, Side };

export interface ProtectSession {
  readonly userId: string;
  readonly network: NetworkName;
  readonly accountId: number | undefined;
  readonly expiresAtMs: number;
}

/** One offered top-up, its label exactly as the bot renders it. */
export interface ProtectOption {
  readonly intent: 'clear-danger' | 'to-safe';
  readonly label: string;
  /** AUSD micros, the CEILED figure the label shows. Sent verbatim. */
  readonly amountCNS: string;
  readonly amountAusd: number;
}

export interface ProtectInFlight {
  readonly idempotencyKey: string;
  readonly sinceMs: number;
}

export interface ProtectPosition {
  readonly marketId: number;
  readonly symbol: string;
  readonly side: Side | undefined;
  readonly positionId: number | undefined;
  readonly state: RiskState;
  readonly lastKnownState: RiskState | undefined;
  /** The alerts renderer's headline, e.g. "DANGER · BTC long". */
  readonly title: string;
  /** The alerts renderer's body lines, the same ones a Telegram alert carries. */
  readonly lines: readonly string[];
  /** SIGNED. Negative is past liquidation. */
  readonly liqBufferPct: number | undefined;
  /** "buffer 2.7%" or "past liquidation": the words, from the renderer. */
  readonly bufferText: string;
  readonly liquidationPrice: number | undefined;
  readonly markPrice: number;
  readonly priceDecimals: number;
  readonly size: number | undefined;
  readonly entryPrice: number | undefined;
  readonly leverage: number | undefined;
  readonly marginAusd: number;
  readonly notionalAusd: number;
  readonly maintenanceMarginAusd: number;
  readonly unrealisedPnlAusd: number;
  readonly marginToSurviveAusd: number;
  readonly priceAgeMs: number | undefined;
  readonly priceIsOld: boolean;
  readonly heldOnStalePrice: boolean;
  readonly reason: string;
  readonly options: readonly ProtectOption[];
  /** From the ACTING venue. Buttons render disabled with the reason when not actionable. */
  readonly availability: ActionAvailability | undefined;
  /** Present while an action on this market has not settled, whoever started it. */
  readonly inFlight: ProtectInFlight | undefined;
  readonly atMs: number;
}

export type ProtectFreeBalance =
  | { readonly known: true; readonly floorAusd: number; readonly floorCNS: string }
  | { readonly known: false; readonly reason: string };

export interface ProtectSnapshot {
  readonly network: NetworkName;
  readonly accountId: number | undefined;
  readonly forwardingAllowed: boolean | undefined;
  readonly feed: FeedHealth;
  readonly positionsStatus: PositionSourceStatus;
  readonly freeBalance: ProtectFreeBalance;
  readonly thresholds: RiskThresholds;
  readonly positions: readonly ProtectPosition[];
  readonly generatedAtMs: number;
}

export type PrepareRequest =
  | { readonly kind: 'add-margin'; readonly marketId: number; readonly intent: 'clear-danger' | 'to-safe' }
  | { readonly kind: 'add-margin'; readonly marketId: number; readonly intent: 'custom'; readonly amount: string }
  | { readonly kind: 'close-position'; readonly marketId: number }
  | { readonly kind: 'kill-switch' };

/** A confirmation screen. `lines` ends with "Nothing has been sent yet." */
export interface Prepared {
  readonly token: string;
  readonly kind: PrepareRequest['kind'];
  readonly marketId: number | undefined;
  readonly symbol: string | undefined;
  readonly title: string;
  readonly lines: readonly string[];
  readonly expiresAtMs: number;
}

export interface ProtectReported {
  readonly status: 'forwarded' | 'confirmed' | 'rejected' | 'timeout' | 'threw';
  readonly reason: string | undefined;
  readonly venueRef: string | undefined;
}

export interface ProtectReconciliation {
  readonly verdict: ReconciledVerdict;
  readonly field: WatchedField;
  readonly requested: string;
  readonly before: string;
  readonly after: string | undefined;
  readonly delta: string | undefined;
  readonly detail: string;
}

export interface ProtectOutcome {
  readonly kind: 'applied' | 'not-applied' | 'unknown' | 'refused';
  readonly marketId: number;
  readonly symbol: string;
  /** The bot's sentence for this outcome, verbatim. */
  readonly text: string;
  /** The actions layer's own account, which for sr 32 says the venue was wrong. */
  readonly detail: string;
  readonly nextStep: string | undefined;
  readonly refusalCode: RefusalCode | undefined;
  readonly reported: ProtectReported | undefined;
  readonly reconciliation: ProtectReconciliation | undefined;
  /** Present ONLY on `not-applied`: a fresh token for the same action. */
  readonly retryToken: string | undefined;
}

export interface ProtectKillSwitchLine {
  readonly order: number;
  readonly marketId: number;
  readonly symbol: string;
  readonly liqBufferPct: number | undefined;
  readonly outcome: ProtectOutcome;
}

export interface ProtectKillSwitchOutcome {
  readonly kind: 'kill-switch';
  readonly complete: boolean;
  /** `describeKillSwitch`, which leads with what did NOT close. */
  readonly text: string;
  readonly lines: readonly ProtectKillSwitchLine[];
}

export type ProtectStage = 'queued' | 'sending' | 'reconciling' | 'settled';

export interface ProtectProgress {
  readonly idempotencyKey: string;
  readonly kind: PrepareRequest['kind'];
  readonly symbol: string | undefined;
  readonly stage: ProtectStage;
  readonly startedAtMs: number;
  /** Set at `reconciling`: what the venue said, which is not the outcome. */
  readonly reported: ProtectReported | undefined;
  readonly outcome: ProtectOutcome | ProtectKillSwitchOutcome | undefined;
}

export interface ProtectStressLine {
  readonly marketId: number;
  readonly symbol: string;
  readonly side: Side;
  readonly survives: boolean;
  /** SIGNED buffer after the shock; negative means liquidated. */
  readonly bufferAfterPct: number | undefined;
  readonly shockedMarkPrice: number;
  readonly marginLostAusd: number;
  readonly unrealisedPnlAusd: number;
}

export type ProtectStress =
  | {
      readonly ok: true;
      readonly priceMoveFraction: number;
      readonly perPosition: readonly ProtectStressLine[];
      readonly liquidatedCount: number;
      readonly survivedCount: number;
      readonly totalMarginLostAusd: number;
      readonly totalUnrealisedPnlAusd: number;
      /** Sum of the margin each liquidated position would have needed to survive. */
      readonly shortfallAusd: number;
      readonly freeBalance: ProtectFreeBalance;
    }
  | { readonly ok: false; readonly reason: string };
