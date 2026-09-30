/**
 * Wallet -> Perpl account id, read off the Exchange contract.
 *
 * ONE `eth_call` to `getAccountByAddr(address)`, which returns the account
 * struct — id, balances, freeze status, owner, position bitmap — as nine
 * fixed-size words. Only the first word is read here. An address with no
 * account does not return id 0: the call REVERTS with a custom error, so a
 * revert is the "no account" answer and a zero id is treated as one too.
 *
 * Venue-specific by nature, so it lives in `venues/`. Pure apart from the
 * injected fetch, so the decoder and the revert path are unit tested.
 */

/** keccak256("getAccountByAddr(address)")[0..4]. Checked against the ABI in the test. */
export const GET_ACCOUNT_BY_ADDR_SELECTOR = '0x12e8eb2c';

export type AccountLookup =
  | { readonly found: true; readonly accountId: number; readonly address: string }
  | { readonly found: false; readonly address: string; readonly reason: string };

export interface AccountLookupOptions {
  readonly rpcUrl: string;
  readonly exchangeAddress: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function lookupAccountByAddress(address: string, options: AccountLookupOptions): Promise<AccountLookup> {
  if (!ADDRESS.test(address)) return { found: false, address, reason: `${JSON.stringify(address)} is not a 0x-prefixed 20-byte address` };
  const lower = address.toLowerCase();
  const data = `${GET_ACCOUNT_BY_ADDR_SELECTOR}${lower.slice(2).padStart(64, '0')}`;
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: options.exchangeAddress, data }, 'latest'] }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    if (!response.ok) return { found: false, address: lower, reason: `the RPC answered ${response.status}` };
    const json = (await response.json()) as { result?: unknown; error?: { message?: string; data?: unknown } };
    if (json.error !== undefined) {
      // The contract's own "no such account" is a revert, and a revert is the
      // ordinary answer for a wallet that never opened one.
      return { found: false, address: lower, reason: 'this wallet has no account on the Exchange' };
    }
    return decodeAccountLookup(json.result, lower);
  } catch (error) {
    return { found: false, address: lower, reason: `could not reach the RPC: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The first word of the struct is the id. Exported for the tests. */
export function decodeAccountLookup(result: unknown, address: string): AccountLookup {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) {
    return { found: false, address, reason: `the RPC returned ${JSON.stringify(result)}, which is not hex` };
  }
  const body = result.slice(2);
  if (body.length < 64) {
    return { found: false, address, reason: 'the RPC returned no data, so the call did not reach the Exchange' };
  }
  const id = BigInt(`0x${body.slice(0, 64)}`);
  if (id === 0n) return { found: false, address, reason: 'this wallet has no account on the Exchange' };
  if (id > BigInt(Number.MAX_SAFE_INTEGER)) return { found: false, address, reason: `account id ${id} is out of range` };
  return { found: true, accountId: Number(id), address };
}
