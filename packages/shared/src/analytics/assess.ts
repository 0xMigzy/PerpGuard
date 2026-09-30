/**
 * A wallet's open positions, assessed against the venue's marks.
 *
 * PURE. The indexer knows a position's side, size, entry and margin; it knows
 * no mark price and no maintenance margin, because neither is an event. Those
 * come from the venue on the SAME network, and the caller supplies both, so
 * this function has no way to price a mainnet position off a testnet mark.
 *
 * Every hole stays a hole, with its reason: a market the venue does not list
 * has no maintenance margin; a market with no mark cannot be valued; an entry
 * price the index never saw cannot anchor a liquidation price. None of those
 * become zero.
 *
 * ACCRUED FUNDING IS NOT INCLUDED. The venue settles it into the position's
 * margin and the index does not carry it per open position with a known sign,
 * so it is passed as zero and named here rather than guessed. On these markets
 * it is a few thousandths of a percent per interval.
 */
import { scaledToNumber } from '../units.ts';
import { positionMetrics } from '../risk/metrics.ts';
import { fromVenuePosition, priceToPNS, type MarketRiskConfig } from '../risk/position.ts';
import type { AssessedPosition, OpenPosition } from './types.ts';

export interface MarkReading {
  readonly markPrice: number;
  readonly atMs: number;
}

export function assessOpenPositions(
  positions: readonly OpenPosition[],
  configs: ReadonlyMap<number, MarketRiskConfig>,
  marks: ReadonlyMap<number, MarkReading>,
): readonly AssessedPosition[] {
  return positions.map((position): AssessedPosition => {
    const id = position.market.marketId;
    const config = configs.get(id);
    const mark = marks.get(id);
    if (config === undefined) {
      return { position, reason: 'the venue does not list this market, so its maintenance margin is unknown' };
    }
    if (mark === undefined) {
      return { position, reason: 'the venue reports no mark for this market' };
    }
    if (position.entryPrice === undefined) {
      return {
        position,
        markPrice: mark.markPrice,
        markAtMs: mark.atMs,
        reason: 'the entry price is unknown: the position was opened before the index starts',
      };
    }
    const risk = fromVenuePosition(
      {
        marketId: id,
        symbol: config.symbol,
        side: position.side,
        size: position.sizeLots,
        entryPrice: position.entryPrice,
        margin: position.marginAusd,
        fundingAccrued: 0,
      },
      config,
    );
    const m = positionMetrics(risk, priceToPNS(mark.markPrice, config), config);
    const ausd = (cns: bigint) => scaledToNumber(cns, config.collateralDecimals);
    return {
      position,
      markPrice: mark.markPrice,
      markAtMs: mark.atMs,
      notionalAusd: ausd(m.notionalCNS),
      unrealisedPnlAusd: ausd(m.unrealisedPnlCNS),
      pnlPctOfMargin: m.pnlPctOfMargin,
      liquidationPrice: m.liquidationPricePNS === undefined ? undefined : scaledToNumber(m.liquidationPricePNS, config.priceDecimals),
      liqBufferPct: m.liqBufferPct,
      isLiquidatable: m.isLiquidatable,
      marginToSurviveAusd: ausd(m.marginToSurviveCNS),
    };
  });
}
