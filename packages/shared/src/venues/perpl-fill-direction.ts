/**
 * What a fill DID to its account's position, read off the position event in
 * the same transaction. A fill (MakerOrderFilled) records neither side nor
 * action; the position events do. All seven forms start with the same three
 * unindexed words: perpId, accountId, positionType (0 = LONG, 1 = SHORT,
 * measured over 496 round trips; anything else throws, never defaults).
 *
 * Venue-specific by nature, so it lives in `venues/`. Decoded by position, no
 * ABI library; the topics are checked against the signatures in the test.
 */
export type FillAction = 'open' | 'add' | 'reduce' | 'close' | 'flip';

export interface PositionEventDirection {
  readonly marketId: number;
  readonly accountId: number;
  readonly action: FillAction;
  /** The position's side as the event states it (for a flip, the side it states). */
  readonly side: 'long' | 'short';
}

/** keccak256 of each signature; pinned in the test. */
export const POSITION_EVENT_ACTIONS: Readonly<Record<string, FillAction>> = {
  // PositionOpenedV2 / PositionOpened
  '0x04cc3d2f': 'open',
  '0xc0150ebb': 'open',
  // PositionIncreasedV2 / PositionIncreased
  '0x99a74f70': 'add',
  '0x2a077a58': 'add',
  '0xcd4a9f7a': 'reduce', // PositionDecreased
  '0x599b5f43': 'close', // PositionClosed
  '0x01a05963': 'flip', // PositionInverted
};

interface ReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** One position event -> its direction, or undefined if the log is not one. Pure. */
export function decodePositionEvent(log: ReceiptLog, exchangeAddress: string): PositionEventDirection | undefined {
  if (log.address.toLowerCase() !== exchangeAddress.toLowerCase()) return undefined;
  const action = POSITION_EVENT_ACTIONS[(log.topics[0] ?? '').slice(0, 10).toLowerCase()];
  if (action === undefined) return undefined;
  const body = log.data.slice(2);
  if (body.length < 3 * 64) return undefined;
  const word = (i: number) => BigInt(`0x${body.slice(i * 64, i * 64 + 64)}`);
  const type = word(2);
  if (type !== 0n && type !== 1n) throw new Error(`positionType ${type} is neither 0 (long) nor 1 (short)`);
  return { marketId: Number(word(0)), accountId: Number(word(1)), action, side: type === 0n ? 'long' : 'short' };
}

/** Every position event in one transaction, from its receipt. */
export async function positionEventsInTx(
  txHash: string,
  options: { readonly rpcUrl: string; readonly exchangeAddress: string; readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number },
): Promise<readonly PositionEventDirection[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(options.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new Error(`eth_getTransactionReceipt: HTTP ${response.status}`);
  const body = (await response.json()) as { result?: { logs?: readonly ReceiptLog[] } | null };
  const logs = body.result?.logs ?? [];
  return logs.map((l) => decodePositionEvent(l, options.exchangeAddress)).filter((d): d is PositionEventDirection => d !== undefined);
}

/**
 * The one event that is this account's on this market, if exactly one is.
 * Two (an unusual transaction) is ambiguous and answers nothing: blank beats a guess.
 */
export function directionFor(events: readonly PositionEventDirection[], accountId: number, marketId: number): PositionEventDirection | undefined {
  const mine = events.filter((e) => e.accountId === accountId && e.marketId === marketId);
  return mine.length === 1 ? mine[0] : undefined;
}

/**
 * Position events for many transactions, in JSON-RPC batches (`batchSize`
 * receipts per request). A transaction whose receipt does not come back is
 * absent from the map: its fills stay blank rather than guessed.
 */
export async function positionEventsInTxs(
  txHashes: readonly string[],
  options: { readonly rpcUrl: string; readonly exchangeAddress: string; readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number; readonly batchSize?: number; readonly concurrency?: number },
): Promise<ReadonlyMap<string, readonly PositionEventDirection[]>> {
  const doFetch = options.fetchImpl ?? fetch;
  const size = Math.max(1, options.batchSize ?? 50);
  const batches: string[][] = [];
  for (let i = 0; i < txHashes.length; i += size) batches.push(txHashes.slice(i, i + size));
  const out = new Map<string, readonly PositionEventDirection[]>();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency ?? 4) }, async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++]!;
        try {
          const response = await doFetch(options.rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(batch.map((tx, id) => ({ jsonrpc: '2.0', id, method: 'eth_getTransactionReceipt', params: [tx] }))),
            signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
          });
          if (!response.ok) continue;
          const raw: unknown = await response.json();
          if (!Array.isArray(raw)) continue;
          for (const r of raw as readonly { readonly id: number; readonly result?: { readonly logs?: readonly ReceiptLog[] } | null }[]) {
            const tx = batch[r.id];
            if (tx === undefined || r.result === undefined || r.result === null) continue;
            const logs: readonly ReceiptLog[] = r.result.logs ?? [];
            out.set(tx.toLowerCase(), logs.map((l) => decodePositionEvent(l, options.exchangeAddress)).filter((d): d is PositionEventDirection => d !== undefined));
          }
        } catch {
          // A failed batch leaves its fills blank; the next request asks again.
        }
      }
    }),
  );
  return out;
}
