/**
 * Finding the trading account id in whatever the socket sends.
 *
 * The account id is documented to live at `as[0].id` on the WalletSnapshot
 * (mt: 19), where the key is `id`, not `acc` — while order, fill and position
 * objects carry the same number under `acc`. Rather than trusting one shape,
 * this walks the whole frame and reports every candidate with the path it was
 * found at, so an unexpected layout is visible rather than fatal.
 *
 * Pure: give it a parsed frame, get candidates back.
 */

export interface AccountIdCandidate {
  readonly accountId: number;
  /** Where it was found, e.g. `as[0].id`. */
  readonly path: string;
  /** Why it counts as a candidate. */
  readonly source: 'acc-field' | 'account-object';
  /** The `mt` of the frame it came from, when the frame had one. */
  readonly mt: number | undefined;
  /** Extra context for the operator: instance id, balance, lfr when present. */
  readonly detail: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * An Account object as the docs define it: an id alongside the last-forwarded
 * request id, and usually an instance id and balance. `lfr` is the giveaway —
 * no other object carries it.
 */
function describeAccountObject(node: Record<string, unknown>): string | undefined {
  if (!('lfr' in node)) return undefined;
  const parts: string[] = [];
  if (typeof node['in'] === 'number') parts.push(`instance ${node['in']}`);
  if (typeof node['lfr'] === 'number') parts.push(`lfr ${node['lfr']}`);
  if (typeof node['b'] === 'string') parts.push(`balance ${node['b']}`);
  if (node['fw'] === false) parts.push('FORWARDING DISABLED');
  if (node['fr'] === true) parts.push('FROZEN');
  return parts.join(', ');
}

/**
 * Every account id in one inbound frame, deduplicated by id+path.
 */
export function collectAccountIds(message: unknown): AccountIdCandidate[] {
  const mt = isRecord(message) && typeof message['mt'] === 'number' ? message['mt'] : undefined;
  const found = new Map<string, AccountIdCandidate>();

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (!isRecord(node)) return;

    const accId = asPositiveInt(node['acc']);
    if (accId !== undefined) {
      const at = path === '' ? 'acc' : `${path}.acc`;
      found.set(`${accId}@${at}`, {
        accountId: accId,
        path: at,
        source: 'acc-field',
        mt,
        detail: undefined,
      });
    }

    const detail = describeAccountObject(node);
    const objId = asPositiveInt(node['id']);
    if (detail !== undefined && objId !== undefined) {
      const at = path === '' ? 'id' : `${path}.id`;
      found.set(`${objId}@${at}`, {
        accountId: objId,
        path: at,
        source: 'account-object',
        mt,
        detail,
      });
    }

    for (const [key, value] of Object.entries(node)) {
      visit(value, path === '' ? key : `${path}.${key}`);
    }
  };

  visit(message, '');
  return [...found.values()];
}

/**
 * Pick the id to report to the operator: an account object (which carries
 * `lfr`, and so is the authoritative Account) beats a bare `acc` reference,
 * and the lowest id breaks a tie so repeated runs agree.
 *
 * Returns undefined when candidates disagree in a way that should not be
 * guessed at — more than one distinct account object id.
 */
export function chooseAccountId(candidates: readonly AccountIdCandidate[]): number | undefined {
  const fromObjects = [...new Set(candidates.filter((c) => c.source === 'account-object').map((c) => c.accountId))];
  if (fromObjects.length === 1) return fromObjects[0];
  if (fromObjects.length > 1) return undefined;

  const fromFields = [...new Set(candidates.map((c) => c.accountId))];
  if (fromFields.length === 1) return fromFields[0];
  return undefined;
}
