/**
 * WHERE AN ALERT'S FIGURES COME FROM, AS LINKS AND A TIME (owner, 12 Oct 2026).
 *
 * The last line of an alert or an action result:
 *
 *   0xa217…6205 · tx ↗
 *
 * the wallet, linked to its page on this deployment's own site, and the
 * transaction, linked to the block explorer. They replaced the block footers
 * ("As of block 111,124,139, 140 blocks behind the chain"): a link to the
 * transaction does the provenance job better than a block number, and a plain
 * time ("Oct 12 · 04:36 UTC") says the moment the alert is a claim about.
 *
 *   - A WATCHED-WALLET ALERT is about a MAINNET account on both bots, so its
 *     `tx ↗` is always the mainnet explorer. An ACTION RESULT links the
 *     deployment's own network, and carries no wallet link: it is your account.
 *   - NO LINK RATHER THAN A BROKEN ONE: no hash, no `tx ↗`. An owner address
 *     the index and the chain could not give is shown as the account number,
 *     still linked: "#4532 · tx ↗".
 *
 * Pure. HTML, like everything it is appended to.
 */
/** Telegram HTML's three characters. Kept here so this file imports nothing (plain.ts imports it). */
const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** "Oct 12 · 04:36 UTC". Always UTC: Telegram does not give a chat's timezone. */
export function alertTime(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} · ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** A transaction hash as the explorer wants it: 0x and 64 hex. Undefined for anything else, so nothing broken is ever linked. */
export function txHashOf(value: string | undefined): string | undefined {
  const hex = value?.trim().replace(/^0x/i, '').toLowerCase();
  return hex !== undefined && /^[0-9a-f]{64}$/.test(hex) ? `0x${hex}` : undefined;
}

export interface Provenance {
  /** The account the alert is about. Omit on an action result. */
  readonly wallet?: {
    readonly accountId: number;
    /** The owner's address, when the index or the chain gave one. */
    readonly address: string | undefined;
    /** This deployment's own site (PUBLIC_WEB_URL). Undefined: the wallet is named without a link. */
    readonly siteUrl: string | undefined;
  };
  /** The explorer's transaction URL prefix for the network the transaction is on, e.g. https://monadvision.com/tx/. */
  readonly explorerTxUrl?: string | undefined;
  readonly txHash?: string | undefined;
}

/** The links line, or undefined when there is nothing to link. */
export function provenanceLine(p: Provenance): string | undefined {
  const parts: string[] = [];
  if (p.wallet !== undefined) {
    const name = p.wallet.address === undefined ? `#${p.wallet.accountId}` : shortAddress(p.wallet.address);
    parts.push(p.wallet.siteUrl === undefined ? esc(name) : `<a href="${p.wallet.siteUrl.replace(/\/$/, '')}/traders/${p.wallet.accountId}">${esc(name)}</a>`);
  }
  const hash = txHashOf(p.txHash);
  if (hash !== undefined && p.explorerTxUrl !== undefined) parts.push(`<a href="${p.explorerTxUrl}${hash}">tx ↗</a>`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}
