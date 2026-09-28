/**
 * The one place this indexer reads chain state instead of events.
 *
 * Our start block is deliberately recent (~30 days), so the `ContractAdded`
 * events that define a market — its `priceDecimals`, `lotDecimals` and margin
 * fractions — are far behind us: only 4 of the 9 live markets were ever listed
 * with `ContractAddedV2` at all, and none of the listings are inside the window.
 * Without those exponents every notional would be wrong, and CLAUDE.md forbids
 * hard-coding them.
 *
 * So a market first seen inside the window is bootstrapped from the contract
 * itself. Envio's Effect API batches, rate-limits and caches these calls, and
 * there are at most a handful of markets, so this happens a few times per resync
 * and never again.
 */
import { S, createEffect } from "envio";
import { createPublicClient, http } from "viem";
import exchangeAbi from "../../abis/Exchange.json" with { type: "json" };

const RPC_URL = process.env.ENVIO_PERPL_RPC_URL ?? "https://rpc.monad.xyz";
const EXCHANGE_ADDRESS = (process.env.ENVIO_PERPL_EXCHANGE ??
  "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F") as `0x${string}`;

const client = createPublicClient({ transport: http(RPC_URL) });
const abi = exchangeAbi as unknown as readonly unknown[];

/**
 * Market definition as the contract reports it today.
 *
 * `getPerpetualInfoV2` is the live replacement for `getPerpetualInfo`, which the
 * deployed mainnet build dropped. `getMarginFractions` takes a lot size because
 * the initial margin can be size-dependent; 0 asks for the base fractions.
 */
export const getMarketInfo = createEffect(
  {
    name: "getMarketInfo",
    input: S.bigint,
    output: S.schema({
      name: S.string,
      symbol: S.string,
      priceDecimals: S.number,
      lotDecimals: S.number,
      status: S.number,
      markPNS: S.bigint,
      longOpenInterestLNS: S.bigint,
      shortOpenInterestLNS: S.bigint,
      initMarginFracHdths: S.bigint,
      maintMarginFracHdths: S.bigint,
      maxOpenInterestLNS: S.bigint,
    }),
    rateLimit: { calls: 5, per: "second" },
    cache: true,
  },
  async ({ input: perpId, context }) => {
    const [info, fractions] = await Promise.all([
      client.readContract({
        address: EXCHANGE_ADDRESS,
        abi,
        functionName: "getPerpetualInfoV2",
        args: [perpId],
      }) as Promise<Record<string, unknown>>,
      client.readContract({
        address: EXCHANGE_ADDRESS,
        abi,
        functionName: "getMarginFractions",
        args: [perpId, 0n],
      }) as Promise<readonly bigint[]>,
    ]);
    context.log.info(`bootstrapped market ${perpId} from chain`);
    return {
      name: String(info["name"] ?? ""),
      symbol: String(info["symbol"] ?? ""),
      priceDecimals: Number(info["priceDecimals"]),
      lotDecimals: Number(info["lotDecimals"]),
      status: Number(info["status"]),
      markPNS: BigInt(info["markPNS"] as bigint),
      longOpenInterestLNS: BigInt(info["longOpenInterestLNS"] as bigint),
      shortOpenInterestLNS: BigInt(info["shortOpenInterestLNS"] as bigint),
      initMarginFracHdths: fractions[0] ?? 0n,
      maintMarginFracHdths: fractions[1] ?? 0n,
      maxOpenInterestLNS: fractions[3] ?? 0n,
    };
  },
);

/** Collateral token and its decimals, plus the implementation behind the proxy. */
export const getExchangeIdentity = createEffect(
  {
    name: "getExchangeIdentity",
    input: S.schema(undefined),
    output: S.schema({
      collateralToken: S.string,
      collateralDecimals: S.number,
      implementation: S.string,
      contractVersion: S.string,
      halted: S.boolean,
    }),
    rateLimit: { calls: 5, per: "second" },
    cache: true,
  },
  async () => {
    const [info, version, halted, implSlot] = await Promise.all([
      client.readContract({
        address: EXCHANGE_ADDRESS,
        abi,
        functionName: "getExchangeInfo",
      }) as Promise<readonly unknown[]>,
      client.readContract({
        address: EXCHANGE_ADDRESS,
        abi,
        functionName: "getContractVersion",
      }) as Promise<readonly bigint[]>,
      client.readContract({
        address: EXCHANGE_ADDRESS,
        abi,
        functionName: "isHalted",
      }) as Promise<boolean>,
      // ERC-1967 implementation slot. The ABI has no getter for it.
      client.getStorageAt({
        address: EXCHANGE_ADDRESS,
        slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      }),
    ]);
    return {
      collateralToken: String(info[4]),
      collateralDecimals: Number(info[3]),
      implementation: implSlot ? `0x${implSlot.slice(-40)}` : "",
      contractVersion: version.map(String).join("."),
      halted,
    };
  },
);
