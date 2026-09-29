/**
 * Streams live Perpl prices into the market feed and prints them.
 *
 *   pnpm prices              # every market on the analytics network
 *   pnpm prices BTC ETH      # just these
 *
 * The Day 1 acceptance check for the price path: it proves the market-data
 * websocket connects, that prices descale correctly per market, that
 * STALE_MS is enforced, and — if you cut the network while it runs — that the
 * feed backs off, reconnects, resubscribes and recovers on its own.
 *
 * Read-only. It runs against the analytics network (mainnet by default) so the
 * demo shows real prices, and it cannot submit anything.
 */
import {
  PerplVenue,
  loadAppConfig,
  type FeedEvent,
  type PriceUpdate,
} from '@perpguard/shared';
import { MarketFeed } from '../ingest/marketFeed.ts';

const REFRESH_MS = 1_000;

function clock(): string {
  return new Date().toISOString().slice(11, 23);
}

function event(message: string): void {
  process.stdout.write(`[${clock()}] ${message}\n`);
}

function describeEvent(status: FeedEvent): string {
  switch (status.kind) {
    case 'connected':
      return status.attempt === 0
        ? 'CONNECTED to the market-data websocket'
        : `RECONNECTED after ${status.attempt} failed attempt(s)`;
    case 'subscribed':
      return `subscribed (${status.reason})`;
    case 'disconnected':
      return `DISCONNECTED (${status.error.message}) — retrying in ${status.retryInMs}ms, attempt ${status.attempt}`;
    case 'closed':
      return 'feed closed';
  }
}

function formatPrice(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main(): Promise<void> {
  const config = loadAppConfig(process.env);
  const venue = new PerplVenue(config.analytics, { readOnly: true });

  const markets = await venue.getMarkets();
  const requested = process.argv.slice(2).map((s) => s.toUpperCase());
  const symbols =
    requested.length > 0 ? requested : markets.map((m) => m.symbol).sort().slice(0, 8);

  const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
  const feed = new MarketFeed(config.analytics.name, config.staleMs);

  event(
    `watching ${symbols.length} market(s) on Perpl ${config.analytics.name} ` +
      `(chain ${config.analytics.chainId}), STALE_MS=${config.staleMs}`,
  );
  event(`market-data url: ${config.analytics.marketDataWsUrl}`);
  event(`symbols: ${symbols.join(', ')}`);

  let ticks = 0;
  const unsubscribeEvents = await venue.onFeedEvent((status) => {
    event(describeEvent(status));
  });

  const unsubscribe = await venue.subscribePrices(symbols, (update: PriceUpdate) => {
    feed.record(update);
    ticks += 1;
  });

  const render = (): void => {
    // Connection health and price age are shown as two separate things,
    // because they answer different questions. A quiet market is old and
    // fine; a frozen one can look young and be dangerous.
    const health = venue.feedStatus();
    const cells = symbols.map((symbol) => {
      const market = bySymbol.get(symbol);
      if (market === undefined) return `${symbol} ?`;
      const update = feed.get(market.marketId);
      const gate = feed.canAct(market.marketId, health);
      if (update === undefined) return `${symbol} no-price`;
      const age = gate.ageMs === undefined ? '—' : `${gate.ageMs}ms`;
      // 'quiet' = old price, healthy feed: actionable. 'BLOCKED' = not.
      const tag = gate.ok ? (gate.priceIsOld ? ' quiet' : '') : ' BLOCKED';
      return `${symbol} ${formatPrice(update.markPrice)} ${age}${tag}`;
    });
    const feedTag = health.state.toUpperCase();
    process.stdout.write(
      `[${clock()}] feed=${feedTag} ${ticks} ticks | ${cells.join('  |  ')}\n`,
    );
  };

  const timer = setInterval(render, REFRESH_MS);

  const shutdown = (): void => {
    clearInterval(timer);
    unsubscribe();
    unsubscribeEvents();
    venue.disconnect();
    event('stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
