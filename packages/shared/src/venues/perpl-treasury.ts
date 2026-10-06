/**
 * The protocol treasury's AUSD in and out of the Perpl Exchange, read off the
 * chain's logs, and the contract's AUSD balance at a block.
 *
 * Only `ProtocolBalanceDeposit(uint256)` and `ProtocolBalanceWithdraw(uint256)`
 * move AUSD across the contract's edge; every other treasury event moves money
 * inside it. Together with the indexed collateral deposits and withdrawals they
 * rebuild the contract's balance (docs/notes and CLAUDE.md, 6 Oct 2026). The
 * index does not handle them, and adding handlers would force a re-sync, so
 * they are scanned here. Both events are rare (20 since launch), so each one is
 * dated by its own block.
 *
 * Decoded by position, without an ABI library, like `perpl-insurance.ts`: the
 * one argument is unindexed, so it is the log's only data word.
 */

/** keccak256("ProtocolBalanceDeposit(uint256)"); checked against the signature in the test. */
export const PROTOCOL_BALANCE_DEPOSIT_TOPIC = '0x06d9a2e5d1f47e8b66c517104114f36514593b09c9b90cb622a6883e595d4bcd';
/** keccak256("ProtocolBalanceWithdraw(uint256)"). */
export const PROTOCOL_BALANCE_WITHDRAW_TOPIC = '0xfbebce9e66eea6596d62b805af61b4b1ea406128e73ffb928faa091b17d524f9';
/** balanceOf(address). */
export const BALANCE_OF_SELECTOR = '0x70a08231';

/** The RPC refuses wider `eth_getLogs` spans with HTTP 413 (measured, 6 Oct 2026). */
export const LOG_PAGE_BLOCKS = 1_000;

export interface TreasuryMovement {
  readonly block: number;
  readonly txHash: string;
  readonly logIndex: number;
  readonly atMs: number;
  readonly direction: 'in' | 'out';
  readonly amountCNS: bigint;
}

export interface TreasuryRpcOptions {
  readonly rpcUrl: string;
  readonly exchangeAddress: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface RpcLog {
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
  readonly topics: readonly string[];
  readonly data: string;
}

const hex = (n: number) => `0x${n.toString(16)}`;

async function rpc<T>(options: TreasuryRpcOptions, method: string, params: unknown[]): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(options.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? 'no result'}`);
  return body.result;
}

/** One treasury log -> a movement, or undefined if it is not one of the two events. Pure. */
export function decodeTreasuryLog(log: RpcLog, atMs: number): TreasuryMovement | undefined {
  const topic = log.topics[0]?.toLowerCase();
  const direction = topic === PROTOCOL_BALANCE_DEPOSIT_TOPIC ? 'in' : topic === PROTOCOL_BALANCE_WITHDRAW_TOPIC ? 'out' : undefined;
  if (direction === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) throw new Error(`a treasury log's data is not one word: ${log.data.slice(0, 20)}…`);
  return {
    block: Number(BigInt(log.blockNumber)),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex)),
    atMs,
    direction,
    amountCNS: BigInt(log.data),
  };
}

/** The latest FINALIZED block: a scan never reads past it, so nothing it stores can be reorganised away. */
export async function finalizedBlock(options: TreasuryRpcOptions): Promise<number> {
  const block = await rpc<{ number: string }>(options, 'eth_getBlockByNumber', ['finalized', false]);
  return Number(BigInt(block.number));
}

/**
 * Every treasury movement in [from, to], oldest first, in pages the RPC
 * accepts. Each movement is dated by its block (one call per distinct block;
 * they are rare).
 */
export async function scanTreasuryMovements(from: number, to: number, options: TreasuryRpcOptions & { readonly concurrency?: number }): Promise<readonly TreasuryMovement[]> {
  if (to < from) return [];
  const pages: [number, number][] = [];
  for (let a = from; a <= to; a += LOG_PAGE_BLOCKS) pages.push([a, Math.min(a + LOG_PAGE_BLOCKS - 1, to)]);
  const logs: RpcLog[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency ?? 4) }, async () => {
      while (cursor < pages.length) {
        const [a, b] = pages[cursor++]!;
        logs.push(
          ...(await rpc<RpcLog[]>(options, 'eth_getLogs', [
            { address: options.exchangeAddress, topics: [[PROTOCOL_BALANCE_DEPOSIT_TOPIC, PROTOCOL_BALANCE_WITHDRAW_TOPIC]], fromBlock: hex(a), toBlock: hex(b) },
          ])),
        );
      }
    }),
  );
  const times = new Map<number, number>();
  for (const block of new Set(logs.map((l) => Number(BigInt(l.blockNumber))))) {
    const b = await rpc<{ timestamp: string }>(options, 'eth_getBlockByNumber', [hex(block), false]);
    times.set(block, Number(BigInt(b.timestamp)) * 1000);
  }
  return logs
    .map((l) => decodeTreasuryLog(l, times.get(Number(BigInt(l.blockNumber)))!))
    .filter((m): m is TreasuryMovement => m !== undefined)
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

/** The contract's balance of `token` at `block`. The RPC keeps state only a few days back, so `block` must be recent. */
export async function collateralBalanceAt(token: string, block: number, options: TreasuryRpcOptions): Promise<bigint> {
  const data = `${BALANCE_OF_SELECTOR}${options.exchangeAddress.slice(2).toLowerCase().padStart(64, '0')}`;
  return BigInt(await rpc<string>(options, 'eth_call', [{ to: token, data }, hex(block)]));
}
