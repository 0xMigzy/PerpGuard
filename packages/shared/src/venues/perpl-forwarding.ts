/**
 * The forwarding pre-flight.
 *
 * Perpl accounts do not permit API-key-forwarded orders by default. The owner
 * turns it on with a wallet transaction, `allowOrderForwarding(true)` on the
 * Exchange; there is no on-chain getter and no API key can set it. The only
 * thing we can read is `fw` on the `mt: 21` account snapshot.
 *
 * Without this check a submission is admitted by the gateway (`mt: 3`,
 * `code: 0`) and only fails later on `mt: 24` with sr 34 — burning an `rq`,
 * a round trip and, for a position near liquidation, the seconds that matter.
 *
 * Pure on purpose: no socket, no I/O, so the wording is unit-testable and the
 * executor keeps one narrow line of wiring.
 */
import { VenueError } from '../errors.ts';

const VENUE_ID = 'perpl';

/** Perpl's rejection code for a forward from an account with `fw` false. */
export const SR_ORDER_FORWARDING_NOT_ALLOWED = 34;

export interface ForwardingPreflightInput {
  /** `fw` from the `mt: 21` snapshot. Undefined means no snapshot yet. */
  readonly forwardingAllowed: boolean | undefined;
  /** For the message only; undefined before the snapshot arrives. */
  readonly accountId?: number | undefined;
  readonly network: string;
}

/**
 * An account whose `fw` flag is false. Thrown before anything is sent, so no
 * `rq` is spent and there is nothing to reconcile.
 */
export class ForwardingNotAllowedError extends VenueError {
  readonly accountId: number | undefined;
  readonly network: string;

  constructor(message: string, details: { accountId?: number | undefined; network: string }) {
    super(VENUE_ID, message);
    this.name = 'ForwardingNotAllowedError';
    this.accountId = details.accountId;
    this.network = details.network;
  }
}

/**
 * Why this account cannot be acted on, or undefined when it can.
 *
 * Fails closed only on a definite `false`. An absent `fw` means the snapshot
 * has not arrived, not that forwarding is off, and blocking on that would
 * ground every action on a slow sign-in — the venue has its own errors for a
 * snapshot that never comes.
 */
export function forwardingBlockReason(input: ForwardingPreflightInput): string | undefined {
  if (input.forwardingAllowed !== false) return undefined;

  const account = input.accountId === undefined ? 'this account' : `account ${input.accountId}`;
  return (
    `${account} does not allow API-key-forwarded orders (\`fw\` is false on the ` +
    `mt 21 snapshot), so nothing was submitted. The account OWNER must send ` +
    `allowOrderForwarding(true) to the Perpl Exchange on ${input.network} from their own ` +
    `wallet — an API key cannot set this flag, and it is off on every new account. ` +
    `Submitting anyway would be admitted for forwarding and then rejected with ` +
    `sr ${SR_ORDER_FORWARDING_NOT_ALLOWED} (OrderForwardingNotAllowed).`
  );
}

/** Throws ForwardingNotAllowedError unless this account permits forwarding. */
export function assertForwardingAllowed(input: ForwardingPreflightInput): void {
  const reason = forwardingBlockReason(input);
  if (reason === undefined) return;
  throw new ForwardingNotAllowedError(reason, {
    accountId: input.accountId,
    network: input.network,
  });
}
