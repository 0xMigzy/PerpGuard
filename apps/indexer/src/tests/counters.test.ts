/**
 * The three open-position counters must agree with the Position rows.
 *
 * Exchange.openPositionCount sat at 0 through 20.8M indexed events while Market
 * and Trader were correct, because the position lifecycle threaded those two
 * entities and not the third. `pnpm verify` only checked Market, so nothing
 * said so. This test drives an open and a close through the real handlers and
 * asserts all three counters, so the gap cannot reopen silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// createTestIndexer resolves config.yaml relative to the working directory, so
// this file has to run from the indexer package root. `node --test` gives each
// test file its own process, so the chdir cannot reach any other test. It must
// happen before envio is imported.
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));

const { createTestIndexer } = await import("envio");
await import("../handlers/positions.ts");

const CHAIN = 143;
const PERP_ID = 1n;
const ACCOUNT_ID = 4242n;

/**
 * Preset Exchange and Market so the handlers never reach for the chain: both
 * loaders return early when the row already exists. Trader is left out on
 * purpose — letting loadTrader create it exercises the ordering that makes
 * accountCount and openPositionCount survive the same event.
 */
function seed(indexer: ReturnType<typeof createTestIndexer>): void {
  indexer.Exchange.set({
    id: String(CHAIN),
    address: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F",
    implementation: "0xa9ab97a4b9b7e69e4b4ff7b2b1f0b2f0b2f0791b",
    contractVersion: "1.7.5",
    halted: false,
    collateralToken: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
    collateralDecimals: 6,
    accountCount: 0,
    marketCount: 1,
    openPositionCount: 0,
    tradeCount: 0n,
    volumeCNS: 0n,
    feesCNS: 0n,
    liquidationCount: 0,
    liquidatedNotionalCNS: 0n,
    liquidationsWithSpareBalanceCount: 0,
    rescuableLiquidationCount: 0,
    spareBalanceAtLiquidationCNS: 0n,
    liquidationsWithUnknownPositionCount: 0,
    unattributedTakerFeeCNS: 0n,
    lastUpgradeBlock: undefined,
    lastUpgradeAt: undefined,
    updatedBlock: 0n,
  });
  indexer.Market.set({
    id: String(PERP_ID),
    perpId: PERP_ID,
    name: "BTC Perp",
    symbol: "BTC",
    priceDecimals: 1,
    lotDecimals: 5,
    status: 1,
    paused: false,
    listed: true,
    initMarginFracHdths: 1500n,
    maintMarginFracHdths: 2500n,
    maxOpenInterestLNS: 0n,
    markPricePNS: 830000n,
    markUpdatedBlock: 0n,
    markUpdatedAt: new Date(0),
    lastFundingRatePct100k: undefined,
    lastFundingAt: undefined,
    longLotsDeltaLNS: 0n,
    shortLotsDeltaLNS: 0n,
    openInterestDeltaLNS: 0n,
    openPositionCount: 0,
    tradeCount: 0n,
    volumeCNS: 0n,
    feesCNS: 0n,
    liquidationCount: 0,
    liquidatedNotionalCNS: 0n,
    rescuableLiquidationCount: 0,
    oiUnverifiedCloseCount: 0,
    firstSeenBlock: 0n,
    firstSeenAt: new Date(0),
  });
}

/** Every counter that claims to count open positions, plus the rows. */
async function counters(indexer: ReturnType<typeof createTestIndexer>) {
  const exchange = await indexer.Exchange.getOrThrow(String(CHAIN));
  const market = await indexer.Market.getOrThrow(String(PERP_ID));
  const trader = await indexer.Trader.getOrThrow(String(ACCOUNT_ID));
  const rows = (await indexer.Position.getAll()).filter((p) => p.status === "OPEN").length;
  return {
    exchange: exchange.openPositionCount,
    market: market.openPositionCount,
    trader: trader.openPositionCount,
    rows,
  };
}

test("opening a position moves all three open-position counters", async () => {
  const indexer = createTestIndexer();
  seed(indexer);

  await indexer.process({
    chains: {
      [CHAIN]: {
        simulate: [
          {
            contract: "Exchange",
            event: "PositionOpenedV2",
            params: {
              perpId: PERP_ID,
              accountId: ACCOUNT_ID,
              positionType: 0n, // 0 = LONG
              leverageHdths: 1500n,
              depositCNS: 2810330000n,
              pnlCollateralizedCNS: 0n,
              pricePNS: 840295n,
              lotLNS: 50000n,
              insFeeCNS: 0n,
              protFeeCNS: 0n,
              priceResiduePNSQ16: 0n,
            },
          },
        ],
      },
    },
  });

  assert.deepEqual(await counters(indexer), {
    exchange: 1,
    market: 1,
    trader: 1,
    rows: 1,
  });
});

test("closing it takes all three back down, and accountCount survives", async () => {
  const indexer = createTestIndexer();
  seed(indexer);

  await indexer.process({
    chains: {
      [CHAIN]: {
        simulate: [
          {
            contract: "Exchange",
            event: "PositionOpenedV2",
            params: {
              perpId: PERP_ID,
              accountId: ACCOUNT_ID,
              positionType: 0n,
              leverageHdths: 1500n,
              depositCNS: 2810330000n,
              pnlCollateralizedCNS: 0n,
              pricePNS: 840295n,
              lotLNS: 50000n,
              insFeeCNS: 0n,
              protFeeCNS: 0n,
              priceResiduePNSQ16: 0n,
            },
          },
          {
            contract: "Exchange",
            event: "PositionClosed",
            params: {
              perpId: PERP_ID,
              accountId: ACCOUNT_ID,
              positionType: 0n,
              pricePNS: 840073n,
              deltaPnlCNS: -1110000n,
              fundingCNS: 0n,
            },
          },
        ],
      },
    },
  });

  assert.deepEqual(await counters(indexer), {
    exchange: 0,
    market: 0,
    trader: 0,
    rows: 0,
  });

  // The Exchange row is written by loadTrader (accountCount) and by the
  // position lifecycle (openPositionCount) on the same event. Threading the
  // copy through is what keeps the first from being clobbered by the second.
  const exchange = await indexer.Exchange.getOrThrow(String(CHAIN));
  assert.equal(exchange.accountCount, 1, "accountCount must survive the position write");
  assert.equal(exchange.marketCount, 1, "marketCount must survive the position write");
});
