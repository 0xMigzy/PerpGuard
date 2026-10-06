/**
 * The day-1 write-path check: sign in, place one tiny resting limit order far
 * from the market on testnet, follow it to its real outcome, then cancel it and
 * follow that too.
 *
 *   pnpm order:test
 *   pnpm order:test --symbol ETH --distance 0.6 --verbose
 *
 * What it proves, in order: the Ed25519 sign-in frame is accepted; the account
 * id and request-id seed arrive; market ids and scaling come from the context
 * rather than from anywhere in our code; a submission is admitted (mt 3); and
 * the real outcome arrives separately (mt 24). Nothing is reported as success
 * before that last step.
 *
 * With PERPL_ACCOUNT_ID unset it stops after sign-in and reports the account id
 * it discovered, without placing anything.
 *
 * Everything it sends goes through the Venue interface, so the week-3 action
 * executor inherits this signing and result-tracking path rather than
 * reimplementing it.
 */
import { parseArgs } from 'node:util';
import {
  ActionTimeoutError,
  PerplVenue,
  chooseAccountId,
  collectAccountIds,
  formatAusd,
  forwardingBlockReason,
  loadNetworkConfig,
  loadPerplCredentials,
  maskApiKey,
  priceFromRaw,
  reconcileOrderState,
  scalePriceAwayFromMarket,
  type AccountIdCandidate,
  type ActionResult,
  type PerplTradingSocket,
  type Side,
  type Venue,
  type VenueMarket,
} from '@perpguard/shared';

const EXIT_OK = 0;
const EXIT_CONFIG = 1;
const EXIT_REJECTED = 2;
const EXIT_UNKNOWN = 3;

/** How long to listen for account ids before giving up on discovery. */
const DISCOVERY_WINDOW_MS = 10_000;

/** The order must sit at least this far from the mark, or we do not send it. */
const MIN_DISTANCE_FROM_MARK = 0.2;

const { values } = parseArgs({
  options: {
    symbol: { type: 'string', default: 'BTC' },
    side: { type: 'string', default: 'long' },
    /** Fraction below (long) or above (short) the mark price. */
    distance: { type: 'string', default: '0.5' },
    /** Order size, counted in the market's smallest representable unit. */
    'size-units': { type: 'string', default: '1' },
    leverage: { type: 'string', default: '2' },
    'timeout-ms': { type: 'string', default: '30000' },
    verbose: { type: 'boolean', default: false },
  },
  allowPositionals: false,
  // `pnpm order:test -- --verbose` forwards the separator itself, which
  // parseArgs would otherwise read as a positional and reject.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
});

const logger = {
  log: (message: string) => console.log(message),
  warn: (message: string) => console.warn(`!  ${message}`),
};

function heading(text: string): void {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
}

function numberFlag(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got ${raw}`);
  return value;
}

function describeResult(result: ActionResult): string {
  const ref = result.venueRef === undefined ? '' : ` order ${result.venueRef}`;
  const why = result.reason === undefined ? '' : ` — ${result.reason}`;
  return `${result.status.toUpperCase()}${ref}${why}`;
}

function printCandidates(candidates: readonly AccountIdCandidate[]): void {
  const width = Math.max(4, ...candidates.map((c) => String(c.accountId).length));
  for (const candidate of candidates) {
    const source = candidate.source === 'account-object' ? 'account object' : 'acc reference';
    const detail = candidate.detail === undefined ? '' : ` — ${candidate.detail}`;
    console.log(
      `  ${String(candidate.accountId).padStart(width)}  mt ${String(candidate.mt ?? '?').padStart(3)}  ` +
        `${candidate.path.padEnd(18)}  ${source}${detail}`,
    );
  }
}

/**
 * Sign in only, then report every account id the session mentioned.
 *
 * Deliberately never places an order: the id has to be checked by a human and
 * written into .env before anything is sent with it.
 */
async function discoverAccountId(venue: PerplVenue): Promise<number> {
  heading('No PERPL_ACCOUNT_ID set — discovery mode, nothing will be placed');

  const seen: AccountIdCandidate[] = [];
  const record = (message: unknown): void => {
    for (const candidate of collectAccountIds(message)) {
      if (!seen.some((s) => s.accountId === candidate.accountId && s.path === candidate.path)) {
        seen.push(candidate);
      }
    }
  };

  const socket = await venue.connectTrading();
  // The snapshots arrive before connect() returns, so replay what the socket
  // already holds before subscribing for anything further.
  for (const message of socket.recentMessages) record(message);
  socket.onMessage(record);

  console.log(`listening ${DISCOVERY_WINDOW_MS / 1000}s for account ids…`);
  await new Promise((resolve) => setTimeout(resolve, DISCOVERY_WINDOW_MS));

  const frameTypes = new Map<unknown, number>();
  for (const message of socket.recentMessages) {
    frameTypes.set(message['mt'], (frameTypes.get(message['mt']) ?? 0) + 1);
  }
  console.log(
    `saw ${socket.recentMessages.length} frames: ` +
      `${[...frameTypes].map(([mt, n]) => `mt ${String(mt)} x${n}`).join(', ')}`,
  );

  if (seen.length === 0) {
    console.log('\nNo account id appeared in any inbound message.');
    console.log(
      'The key authenticated, but authenticating a key is not the same as having an\n' +
        'exchange account. Create one with createAccount() on the Exchange contract\n' +
        '(testnet minimum deposit is 100 AUSD), then run this again.',
    );
    process.exit(EXIT_CONFIG);
  }

  heading(`Account ids seen (${seen.length})`);
  printCandidates(seen);

  const chosen = chooseAccountId(seen);
  if (chosen === undefined) {
    console.log('\nMore than one account id appeared. Pick the right one yourself — this');
    console.log('script will not guess which account to trade with.');
    process.exit(EXIT_CONFIG);
  }

  console.log(`\n┌${'─'.repeat(46)}┐`);
  console.log(`│  DISCOVERED ACCOUNT ID: ${String(chosen).padEnd(21)}│`);
  console.log(`└${'─'.repeat(46)}┘`);
  console.log('\nAdd this line to .env, then run `pnpm order:test` again:\n');
  console.log(`    PERPL_ACCOUNT_ID=${chosen}\n`);
  return chosen;
}

/**
 * How much of the order's TTL window is left, in blocks.
 *
 * Approximate on purpose: it is measured from the head block we held just
 * before submitting, and the `lb` actually sent is a couple of blocks shorter
 * than the full TTL. Printed as context, never used to decide anything — the
 * authoritative signal is the order's own status.
 */
function ttlBlocksLeft(
  headNow: number | undefined,
  headAtPlacement: number | undefined,
  market: VenueMarket,
): number | undefined {
  if (headNow === undefined || headAtPlacement === undefined) return undefined;
  return headAtPlacement + market.orderTtlBlocks - headNow;
}

/** Place the order, follow it to mt 24, then cancel it and follow that too. */
async function placeAndCancel(
  venue: Venue,
  /**
   * The live session, for READING only: the order's last known status and the
   * head block. Every submission below still goes through the Venue interface,
   * which is the whole point of this script.
   */
  session: PerplTradingSocket,
  market: VenueMarket,
  params: { side: Side; price: number; size: number; leverage: number; timeoutMs: number },
): Promise<number> {
  const runId = `order-test-${Date.now()}`;

  heading('1/2  Place');
  console.log(
    `  ${params.side} ${params.size.toFixed(market.sizeDecimals)} ${market.symbol} ` +
      `@ ${params.price.toFixed(market.priceDecimals)} ` +
      `(${params.leverage}x, PostOnly, market ${market.marketId})`,
  );

  // Read before submitting: the TTL clock starts from the block the order is
  // sent at, not from the block its outcome arrives at.
  const headAtPlacement = session.headBlock;

  let placed: ActionResult;
  try {
    placed = await venue.placeLimitOrder({
      idempotencyKey: `${runId}:place`,
      marketId: market.marketId,
      symbol: market.symbol,
      side: params.side,
      price: params.price,
      size: params.size,
      leverage: params.leverage,
      postOnly: true,
      timeoutMs: params.timeoutMs,
      onForwarded: () => {
        console.log('  mt 3   code 0 — ACCEPTED FOR FORWARDING ONLY.');
        console.log('         Not posted, not filled. Waiting for the mt 24 outcome…');
      },
    });
  } catch (error) {
    return reportPlacementUnknown(error);
  }

  console.log(`  mt 24  ${describeResult(placed)}`);
  if (placed.status !== 'confirmed') {
    console.log('\nThe order was not posted, so there is nothing to cancel.');
    return EXIT_REJECTED;
  }
  if (placed.venueRef === undefined) {
    console.log('\nConfirmed but with no order id, so the cancel cannot be addressed.');
    return EXIT_REJECTED;
  }

  const orderId = Number(placed.venueRef);

  heading('2/2  Cancel');

  const blocksLeft = ttlBlocksLeft(session.headBlock, headAtPlacement, market);
  if (blocksLeft !== undefined) {
    console.log(
      `  ttl window       ~${blocksLeft} of ${market.orderTtlBlocks} blocks left before the ` +
        `order expires on its own`,
    );
  }

  // Never assume an order we placed is still live. It self-expires at its last
  // execution block within seconds, and cancelling something already gone can
  // produce no mt 24 at all — a 30s wait for an answer that will never come.
  const before = reconcileOrderState(session.lastOrderState(orderId));
  console.log(`  order ${orderId}  ${before.reason}`);

  if (before.state === 'gone') {
    console.log(
      '\n  The order is already gone, so no cancel was sent and no request id was spent.',
    );
    console.log('  An order expiring on its TTL is normal, not a failure — but note that this');
    console.log('  run did NOT exercise the cancel path. Re-run to try again.');
    return EXIT_OK;
  }

  console.log(`  cancelling order ${orderId}`);

  let cancelled: ActionResult;
  try {
    cancelled = await venue.cancelOrder({
      idempotencyKey: `${runId}:cancel`,
      marketId: market.marketId,
      symbol: market.symbol,
      venueOrderId: placed.venueRef,
      timeoutMs: params.timeoutMs,
      onForwarded: () => {
        console.log('  mt 3   code 0 — accepted for forwarding. Waiting for mt 24…');
      },
    });
  } catch (error) {
    return reportCancelTimeout(error, session, orderId);
  }

  console.log(`  mt 24  ${describeResult(cancelled)}`);
  if (cancelled.status !== 'confirmed') {
    console.log(
      `\nThe order is no longer cancellable. Check order ${orderId} on ` +
        `testnet.perpl.xyz before assuming it is gone.`,
    );
    return EXIT_REJECTED;
  }

  heading('Done');
  console.log('  Placed and cancelled, each confirmed on mt 24 rather than on the mt 3 ack.');
  return EXIT_OK;
}

/** A placement timeout is neither success nor failure, and is never reported as either. */
function reportPlacementUnknown(error: unknown): number {
  if (!(error instanceof ActionTimeoutError)) throw error;
  console.log(`\n  TIMED OUT after ${error.waitedMs}ms waiting for the ${error.stage}.`);
  console.log('  OUTCOME UNKNOWN — the order may still be live.');
  console.log(`  Reconcile against rq ${error.requestId ?? '?'} in the order history before`);
  console.log('  retrying; a retry with a new request id could place a second order.');
  return EXIT_UNKNOWN;
}

/**
 * A cancel timeout, reconciled rather than reported as failure.
 *
 * Cancelling an order that has already expired or is otherwise gone may never
 * produce an mt 24, so the wait expiring tells us nothing by itself. What the
 * session last saw for the order id does. The cancel is never re-sent with a
 * fresh request id: the first one may still land.
 */
function reportCancelTimeout(
  error: unknown,
  session: PerplTradingSocket,
  orderId: number,
): number {
  if (!(error instanceof ActionTimeoutError)) throw error;

  console.log(`\n  TIMED OUT after ${error.waitedMs}ms waiting for the ${error.stage}.`);
  console.log('  Not a failure by itself — reconciling against the order instead.');

  const reconciled = reconcileOrderState(session.lastOrderState(orderId));
  console.log(`\n  order ${orderId}  ${reconciled.reason}`);

  if (reconciled.state === 'gone') {
    console.log('\n  RECONCILED — the order is no longer live, so nothing is left dangling.');
    console.log('  The cancel itself was never confirmed on mt 24, so do not record it as the');
    console.log('  reason the order went away. Nothing was re-sent.');
    return EXIT_OK;
  }

  console.log(`\n  OUTCOME UNKNOWN — order ${orderId} may still be resting.`);
  console.log(`  Reconcile against rq ${error.requestId ?? '?'} and the order history on`);
  console.log('  testnet.perpl.xyz. Do NOT re-send the cancel with a new request id: the');
  console.log('  first one may still land, and a second is a new action, not a retry.');
  return EXIT_UNKNOWN;
}

async function main(): Promise<number> {
  const credentials = loadPerplCredentials(process.env);

  // Trading is testnet-only for this project. Refuse rather than warn: the
  // same key shape would work on mainnet, with real money behind it.
  if (credentials.network !== 'testnet') {
    console.error(
      `PERPL_NETWORK is "${credentials.network}". This script only runs against testnet — ` +
        `every trading action in PerpGuard does.`,
    );
    return EXIT_CONFIG;
  }

  const network = loadNetworkConfig(credentials.network, process.env);
  const venue = new PerplVenue(network, {
    credentials: { apiKey: credentials.apiKey, secret: credentials.secret },
    logger,
    verbose: values.verbose === true,
  });

  heading('Perpl test order');
  console.log(`  network   ${network.name} (chain ${network.chainId})`);
  console.log(`  socket    ${network.tradingWsUrl}`);
  console.log(`  api key   ${maskApiKey(credentials.apiKey)}`);
  console.log(`  key id    ${credentials.secret.publicKeyHex()}`);
  console.log(`  account   ${credentials.accountId ?? '(not set — will discover)'}`);

  try {
    if (credentials.accountId === undefined) {
      await discoverAccountId(venue);
      return EXIT_CONFIG;
    }

    const socket = await venue.connectTrading();

    if (socket.accountId !== credentials.accountId) {
      console.error(
        `\nPERPL_ACCOUNT_ID is ${credentials.accountId}, but this key's WalletSnapshot reports ` +
          `${socket.accountId ?? 'no account'}. Submitting against an account the key does not own ` +
          `closes the socket with 1011 and returns no status at all, so this stops here.`,
      );
      return EXIT_CONFIG;
    }
    if (socket.accountFrozen) {
      console.error('\nThe account is frozen; orders will be rejected.');
      return EXIT_CONFIG;
    }
    if (socket.forwardingAllowed === false) {
      heading('Stopping: forwarding is disabled on this account');
      console.error('  The WalletSnapshot reports fw: false. The executor refuses to submit,');
      console.error('  so nothing was sent and no request id was spent.');
      console.error(
        `\n  ${forwardingBlockReason({
          forwardingAllowed: false,
          accountId: socket.accountId,
          network: network.name,
        })}`,
      );
      console.error(
        '\n  Fix it from the wallet that OWNS the exchange account, not from this key:\n' +
          `    Exchange ${network.exchangeAddress} on ${network.name}\n` +
          '    allowOrderForwarding(true)\n' +
          '  then re-run. There is no on-chain getter for the flag; `fw` on the next\n' +
          '  mt 21 snapshot is how we will see it flip.',
      );
      return EXIT_CONFIG;
    }

    const markets = await venue.getMarkets();
    const market = markets.find((m) => m.symbol === values.symbol);
    if (market === undefined) {
      console.error(
        `\n${values.symbol} is not listed on ${network.name}. Available: ` +
          `${markets.map((m) => m.symbol).sort().join(', ')}`,
      );
      return EXIT_CONFIG;
    }

    // Monitoring and actionability are separate. Ask the acting venue.
    const availability = await venue.getActionAvailability(market);
    if (!availability.actionable) {
      heading('Not actionable');
      console.log(`  ${availability.reason}`);
      console.log('  Monitoring and alerts would continue; only the action is disabled.');
      return EXIT_CONFIG;
    }

    const context = await venue.getContext();
    const state = context.markets.find((m) => m.id === market.marketId)?.state;
    if (state === undefined) {
      console.error(`\nno market state for ${market.symbol}; cannot price the order`);
      return EXIT_CONFIG;
    }
    const mark = priceFromRaw(state.mrk, market);

    const side = values.side === 'short' ? 'short' : 'long';
    const distance = numberFlag(values.distance, 'distance');
    if (!(distance >= MIN_DISTANCE_FROM_MARK) || distance >= 1) {
      console.error(
        `\n--distance must be between ${MIN_DISTANCE_FROM_MARK} and 1: this order is meant to ` +
          `rest far from the book, never to trade.`,
      );
      return EXIT_CONFIG;
    }
    // Round to the market's tick here rather than leaving it to the venue, so
    // the price printed below is the price actually sent.
    const target = side === 'long' ? mark * (1 - distance) : mark * (1 + distance);
    const price =
      scalePriceAwayFromMarket(target, side, market.priceDecimals) / 10 ** market.priceDecimals;
    // Via an exponent string: 1 * 10 ** -5 is 0.000009999999999999999 in IEEE 754.
    const sizeUnits = numberFlag(values['size-units'], 'size-units');
    const size = Number(`${sizeUnits}e-${market.sizeDecimals}`);
    const leverage = Math.min(numberFlag(values.leverage, 'leverage'), market.maxLeverage);

    heading(`${market.symbol} on ${network.name}`);
    console.log(`  market id        ${market.marketId} (from GET /v1/pub/context)`);
    console.log(`  scaling          price ${market.priceDecimals}dp, size ${market.sizeDecimals}dp`);
    console.log(`  order ttl        ${market.orderTtlBlocks} blocks — the order expires on its own`);
    console.log(`  mark             ${mark.toFixed(market.priceDecimals)}`);
    console.log(
      `  our limit        ${price.toFixed(market.priceDecimals)} ` +
        `(${(distance * 100).toFixed(0)}% ${side === 'long' ? 'below' : 'above'} mark)`,
    );
    console.log(`  notional         ${formatAusd(price * size)} at ${leverage}x`);

    return await placeAndCancel(venue, socket, market, {
      side,
      price,
      size,
      leverage,
      timeoutMs: numberFlag(values['timeout-ms'], 'timeout-ms'),
    });
  } finally {
    venue.disconnect();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  if (values.verbose === true && error instanceof Error) console.error(error.stack);
  process.exitCode = EXIT_CONFIG;
}
