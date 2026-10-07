/**
 * THE MANUAL ALERT SPEAKS FOR A CROSSING (Part 2). A linked account's own
 * risk loop still decides WATCH and DANGER (the bands on the screens), but
 * its messages for them, and a "recovered" from them, are not sent: the
 * manual alert has said it, once, with the amounts to add. "Past its closing
 * price", "I cannot see your positions" and seeing them again still go out.
 * Watched wallets are not touched by this.
 */
import type { AlertMessage } from '../alerts/types.ts';

export function replacedByManualAlert(message: { readonly kind: AlertMessage['kind']; readonly previousState: AlertMessage['previousState']; readonly watch?: AlertMessage['watch'] | undefined }): boolean {
  if (message.watch !== undefined) return false;
  if (message.kind === 'watch' || message.kind === 'danger') return true;
  return message.kind === 'recovered' && message.previousState !== 'FEED_DOWN' && message.previousState !== 'POSITIONS_UNTRUSTED';
}
