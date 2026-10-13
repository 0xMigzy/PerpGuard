/**
 * THE RESCUE FLOOR (owner, 13 Oct 2026): ONE number per account, the free
 * balance Rescue never spends. Rescue holds, and says so, when a top-up would
 * take the account's free balance below it; it never sends a smaller amount.
 *
 * Whole AUSD, from 0 upward, default 100 for every account that has not set
 * one. Set in ⚙️ Settings. AT 0 RESCUE MAY SPEND THE WHOLE FREE BALANCE, up to
 * each rule's own limits (the amount, the number of top-ups, the total).
 *
 * It is read from the account's settings AT EVERY DECISION, so a change
 * applies at once to rules already on. The figure a rule stored when it was
 * turned on (`rescue_rules.min_remaining_cns`) is a record of that moment and
 * is part of its arming signature; nothing decides on it any more. Until this
 * date the floor was per rule, default 500, and could not go below 100.
 *
 * It holds back AUTOMATION ONLY: a person's own top-up may go below it.
 */
export const RESCUE_FLOOR_PRESETS_AUSD = [0, 50, 100, 250, 500] as const;
export const DEFAULT_RESCUE_FLOOR_AUSD = 100;
/** A bound on what is stored, far above any balance on the venue. */
export const MAX_RESCUE_FLOOR_AUSD = 10_000_000;

export const isRescueFloor = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_RESCUE_FLOOR_AUSD;

/** "0", "36", "1,500", "250 AUSD" -> whole AUSD. No decimals: the screens show whole AUSD. */
export function parseRescueFloor(text: string): { readonly ausd: number } | { readonly error: string } {
  const m = /^\s*(\d{1,8})\s*(?:ausd)?\s*$/i.exec(text.replace(/,/g, ''));
  const v = m === null ? NaN : Number(m[1]);
  if (!isRescueFloor(v)) return { error: 'Send a whole amount in AUSD, 0 or more, like 0, 36 or 250.' };
  return { ausd: v };
}

/** The floor in the collateral token's own units. */
export const rescueFloorCNS = (ausd: number, collateralDecimals: number): bigint => BigInt(ausd) * 10n ** BigInt(collateralDecimals);

/** "100 AUSD", "1,500 AUSD". */
export const rescueFloorLabel = (ausd: number): string => `${ausd.toLocaleString('en-US')} AUSD`;

/**
 * HELD BACK FROM THE FREE BALANCE WHEN A ONE-TAP TOP-UP IS SIZED (the alert, View position): what Rescue has on its
 * way, plus the account's floor WHILE A RESCUE RULE IS ARMED. Nothing armed, no floor held: the floor limits
 * automation, never the person, and it only narrows the suggestions so a tap does not starve an armed rule.
 */
export const heldBackCNS = (o: { readonly anyRuleArmed: boolean; readonly floorCNS: bigint; readonly inFlightCNS: bigint }): bigint => o.inFlightCNS + (o.anyRuleArmed ? o.floorCNS : 0n);
