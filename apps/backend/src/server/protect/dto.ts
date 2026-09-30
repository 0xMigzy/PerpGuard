/**
 * Backend shapes -> the page's shapes. Pure, and it invents no number: every
 * figure is either on the assessment, on the venue's position, or produced by
 * the same renderers the bot uses.
 */
import { scaledToNumber, type ActionAvailability, type MarketRiskConfig, type VenuePosition } from '@perpguard/shared';
import type { KillSwitchPlan, StressResult } from '@perpguard/shared';
import { describeBuffer, formatPricePNS } from '../../alerts/render.ts';
import type { AlertConfig, AlertMessage } from '../../alerts/types.ts';
import type { ActionOutcome } from '../../actions/types.ts';
import type { KillSwitchResult } from '../../actions/killSwitch.ts';
import type { Lease } from '../../actions/inflight.ts';
import type { RiskAssessment } from '../../risk/types.ts';
import type {
  ProtectFreeBalance,
  ProtectKillSwitchOutcome,
  ProtectOutcome,
  ProtectPosition,
  ProtectStress,
} from './types.ts';

const ausd = (cns: bigint, market: MarketRiskConfig): number => scaledToNumber(cns, market.collateralDecimals);
const price = (pns: bigint | undefined, market: MarketRiskConfig): number | undefined =>
  pns === undefined ? undefined : scaledToNumber(pns, market.priceDecimals);

export function toProtectPosition(input: {
  readonly assessment: RiskAssessment;
  readonly message: AlertMessage;
  readonly market: MarketRiskConfig;
  readonly venuePosition: VenuePosition | undefined;
  readonly availability: ActionAvailability | undefined;
  readonly inFlight: Lease | undefined;
  readonly alerts: AlertConfig;
}): ProtectPosition {
  const { assessment: a, message, market, venuePosition: p, alerts } = input;
  return {
    marketId: a.marketId,
    symbol: a.symbol,
    side: a.side,
    positionId: a.positionId,
    state: a.state,
    lastKnownState: a.lastKnownState,
    title: message.title,
    lines: message.lines,
    liqBufferPct: a.liqBufferPct,
    bufferText: describeBuffer(a.liqBufferPct, alerts.bufferDecimals),
    liquidationPrice: price(a.liquidationPricePNS, market),
    markPrice: scaledToNumber(a.markPricePNS, market.priceDecimals),
    priceDecimals: market.priceDecimals,
    size: p?.size,
    entryPrice: p?.entryPrice,
    leverage: p?.leverage,
    marginAusd: p === undefined ? ausd(a.metrics.equityCNS - a.metrics.unrealisedPnlCNS, market) : p.margin,
    notionalAusd: ausd(a.metrics.notionalCNS, market),
    maintenanceMarginAusd: ausd(a.metrics.maintenanceMarginCNS, market),
    unrealisedPnlAusd: ausd(a.metrics.unrealisedPnlCNS, market),
    marginToSurviveAusd: ausd(a.marginToSurviveCNS, market),
    priceAgeMs: a.priceAgeMs,
    priceIsOld: a.priceIsOld,
    heldOnStalePrice: a.heldOnStalePrice,
    reason: a.reason,
    options: message.actions
      .filter((act) => act.intent !== 'custom')
      .map((act) => ({
        intent: act.intent as 'clear-danger' | 'to-safe',
        label: act.label,
        amountCNS: act.amountCNS.toString(),
        amountAusd: ausd(act.amountCNS, market),
      })),
    availability: input.availability,
    inFlight: input.inFlight === undefined ? undefined : { idempotencyKey: input.inFlight.idempotencyKey, sinceMs: input.inFlight.claimedAtMs },
    atMs: a.atMs,
  };
}

/** `text` is the bot's sentence; the rest is the actions layer's own record. */
export function toProtectOutcome(outcome: ActionOutcome, text: string, nextStep: string | undefined, retryToken: string | undefined): ProtectOutcome {
  const reported = outcome.kind === 'refused' ? undefined : outcome.reported;
  const reconciliation = outcome.kind === 'refused' ? undefined : outcome.reconciliation;
  return {
    kind: outcome.kind,
    marketId: outcome.command.marketId,
    symbol: outcome.command.symbol,
    text,
    detail: outcome.detail,
    nextStep,
    refusalCode: outcome.kind === 'refused' ? outcome.code : undefined,
    reported: reported === undefined ? undefined : { status: reported.status, reason: reported.reason, venueRef: reported.venueRef },
    reconciliation:
      reconciliation === undefined
        ? undefined
        : {
            verdict: reconciliation.verdict,
            field: reconciliation.field,
            requested: reconciliation.requested.toString(),
            before: reconciliation.before.toString(),
            after: reconciliation.after?.toString(),
            delta: reconciliation.delta?.toString(),
            detail: reconciliation.detail,
          },
    // ONLY not-applied. Under unknown something may have landed.
    retryToken: outcome.kind === 'not-applied' ? retryToken : undefined,
  };
}

export function toProtectKillSwitch(result: KillSwitchResult, text: string, describe: (o: ActionOutcome) => { text: string; nextStep: string | undefined }): ProtectKillSwitchOutcome {
  return {
    kind: 'kill-switch',
    complete: result.complete,
    text,
    lines: result.lines.map((line) => {
      const words = describe(line.outcome);
      return {
        order: line.order,
        marketId: line.marketId,
        symbol: line.symbol,
        liqBufferPct: line.liqBufferPct,
        // A kill switch line never gets a retry token: re-firing is the thing
        // `describeKillSwitch` warns against.
        outcome: toProtectOutcome(line.outcome, words.text, words.nextStep, undefined),
      };
    }),
  };
}

export function toProtectStress(
  result: StressResult,
  configs: ReadonlyMap<number, MarketRiskConfig>,
  freeBalance: ProtectFreeBalance,
): ProtectStress {
  const move = result.scenario.kind === 'all' ? result.scenario.priceMoveFraction : 0;
  let shortfallCNS = 0n;
  let anyDecimals = 6;
  const perPosition = result.perPosition.map((o) => {
    const market = configs.get(o.position.marketId);
    if (market === undefined) throw new RangeError(`no config for market ${o.position.marketId}`);
    anyDecimals = market.collateralDecimals;
    if (!o.survives) shortfallCNS += o.metrics.marginToSurviveCNS;
    return {
      marketId: o.position.marketId,
      symbol: o.position.symbol,
      side: o.position.side,
      survives: o.survives,
      bufferAfterPct: o.metrics.liqBufferPct,
      shockedMarkPrice: scaledToNumber(o.shockedMarkPricePNS, market.priceDecimals),
      marginLostAusd: ausd(o.marginLostCNS, market),
      unrealisedPnlAusd: ausd(o.metrics.unrealisedPnlCNS, market),
    };
  });
  const totalDecimals = configs.values().next().value?.collateralDecimals ?? anyDecimals;
  return {
    ok: true,
    priceMoveFraction: move,
    perPosition,
    liquidatedCount: result.liquidatedCount,
    survivedCount: result.survivedCount,
    totalMarginLostAusd: scaledToNumber(result.totalMarginLostCNS, totalDecimals),
    totalUnrealisedPnlAusd: scaledToNumber(result.totalUnrealisedPnlCNS, totalDecimals),
    shortfallAusd: scaledToNumber(shortfallCNS, totalDecimals),
    freeBalance,
  };
}

// ── confirmation screens the bot does not have yet ──────────────────────────

/** Close: what will be sent, what it realises, and that a partial fill is reported as such. */
export function renderCloseConfirmation(
  assessment: RiskAssessment,
  market: MarketRiskConfig,
  venuePosition: VenuePosition | undefined,
  alerts: AlertConfig,
): readonly string[] {
  const side = assessment.side === undefined ? '' : ` ${assessment.side}`;
  const size = venuePosition === undefined ? 'the whole position' : `all ${venuePosition.size} ${assessment.symbol}`;
  const lines = [
    `Confirm — close ${assessment.symbol}${side}`,
    `Close ${size} at the mark, ${formatPricePNS(assessment.markPricePNS, market)}.`,
    `Unrealised now: ${ausd(assessment.metrics.unrealisedPnlCNS, market).toFixed(2)} AUSD. Closing realises it, less fees.`,
    `Now: ${describeBuffer(assessment.liqBufferPct, alerts.bufferDecimals)}` +
      (assessment.liquidationPricePNS === undefined ? '' : `, liquidation ${formatPricePNS(assessment.liquidationPricePNS, market)}`) +
      '.',
    'The size sent is the position as the venue reports it at send time. A partial fill leaves the rest open, and the outcome says exactly how far it got.',
  ];
  if (assessment.positionId === undefined) {
    lines.push('I do not have this position’s venue id, so I cannot address the close to it.');
  }
  lines.push('Nothing has been sent yet.');
  return lines;
}

/** Kill switch: every close, in firing order, with what each realises. */
export function renderKillSwitchConfirmation(
  plan: KillSwitchPlan,
  configs: ReadonlyMap<number, MarketRiskConfig>,
  alerts: AlertConfig,
): readonly string[] {
  const n = plan.perPosition.length;
  const lines = [`Confirm — kill switch: close ${n} position${n === 1 ? '' : 's'}, most urgent first`];
  for (const [i, line] of plan.perPosition.entries()) {
    const market = configs.get(line.position.marketId);
    const pnl = market === undefined ? `${line.realisedPnlCNS} micros` : `${ausd(line.realisedPnlCNS, market).toFixed(2)} AUSD`;
    lines.push(
      `${i + 1}. ${line.position.symbol} ${line.position.side} — ${describeBuffer(line.liqBufferPct, alerts.bufferDecimals)}, closing realises ${pnl}`,
    );
  }
  const first = configs.values().next().value;
  const total = first === undefined ? `${plan.projectedRealisedPnlCNS} micros` : `${ausd(plan.projectedRealisedPnlCNS, first).toFixed(2)} AUSD`;
  lines.push(`Projected realised across the book: ${total}.`);
  lines.push('Closes go out one at a time, nearest to liquidation first. A failure does not stop the sequence, and a partial result is reported position by position.');
  lines.push('Nothing has been sent yet.');
  return lines;
}
