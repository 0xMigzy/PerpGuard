/**
 * Which client a linking-page request came from, in words, for the log. Pure.
 *
 * Asked on 6 Oct 2026 to tell Telegram's in-app browser from a real browser:
 * if the session cookie does not survive the connect-and-sign round trip in
 * the in-app browser, the log shows it. What a user-agent CAN tell:
 *
 *   Android: Telegram's in-app browser is a WebView that adds
 *     "Telegram-Android/<version>" (and the WebView's "; wv)") to the agent.
 *   iOS: Telegram opens links in Apple's Safari view controller, whose agent
 *     is IDENTICAL to Safari's. It cannot be told apart by the agent alone,
 *     and this says so rather than guessing.
 *
 * Plus a short fingerprint of the page session (a hash, never the cookie), so
 * one attempt's requests can be strung together in the log.
 */
import { createHash } from 'node:crypto';

export function describeClient(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (ua === '') return 'no user-agent';
  if (/Telegram-Android/i.test(ua)) return 'Telegram in-app browser (Android)';
  if (/Telegram/i.test(ua)) return 'Telegram client';
  if (/Rabby/i.test(ua)) return 'Rabby in-app browser';
  if (/MetaMaskMobile/i.test(ua)) return 'MetaMask in-app browser';
  const android = /Android/i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua);
  if (android && /; wv\)/.test(ua)) return 'Android WebView (an app\'s in-app browser, not Telegram\'s)';
  if (ios && /CriOS/.test(ua)) return 'Chrome (iOS)';
  if (ios && /FxiOS/.test(ua)) return 'Firefox (iOS)';
  if (ios && /Safari/.test(ua)) return 'Safari or an in-app Safari view (iOS: indistinguishable by agent)';
  if (ios) return 'an iOS in-app web view';
  if (android && /SamsungBrowser/.test(ua)) return 'Samsung Internet (Android)';
  if (android && /Chrome\//.test(ua)) return 'Chrome (Android)';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome (desktop)';
  if (/Safari\//.test(ua)) return 'Safari (desktop)';
  return 'an unrecognised client';
}

/** A short, stable fingerprint of a session token: enough to group lines, useless as the token. */
export const sessionTag = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 8);

/** "Telegram in-app browser (Android) [Mozilla/5.0 (Linux; Android 14; ...)]": the agent, cut short. */
export function clientLine(userAgent: string | undefined): string {
  return `${describeClient(userAgent)} [${(userAgent ?? '').slice(0, 140)}]`;
}
