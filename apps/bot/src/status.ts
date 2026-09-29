/**
 * `/status` — is this monitor actually working?
 *
 * The one command whose failure mode is the whole product's failure mode. A risk
 * monitor that has gone blind must never look healthy, so this answers the three
 * questions SEPARATELY rather than collapsing them into a single green tick:
 *
 *   connection health   — is the price feed connected? While it is not, every
 *                         price we hold is frozen at whatever it was when the
 *                         connection died, and nothing may be acted on.
 *   position trust      — does the set of open positions reflect reality? A
 *                         position closed a minute ago looks exactly like one
 *                         still open, so the source has to be asked.
 *   price age           — how old is each market's price? This one is NOT a
 *                         health question. On Perpl a mark price only changes
 *                         when it moves, so a quiet market has an old price that
 *                         is the venue's current truth. It is reported, never
 *                         presented as a fault.
 *
 * Pure. Everything it needs is passed in, so the down-and-untrusted paths test
 * without a socket.
 */
import type {
  FeedHealth,
  NetworkName,
  PositionSourceStatus,
} from '@perpguard/shared';
import type { RiskAssessment } from '@perpguard/backend/risk';

export interface StatusInput {
  /** The one network this loop assesses. */
  readonly network: NetworkName;
  readonly feed: FeedHealth;
  readonly positions: PositionSourceStatus;
  /** Whatever the loop currently holds. Empty is meaningful only when live. */
  readonly assessments: readonly RiskAssessment[];
  readonly nowMs: number;
}

/** A duration in words. Deliberately coarse: this is a status line, not a clock. */
export function describeDuration(ms: number | undefined): string {
  if (ms === undefined) return 'unknown';
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The feed line.
 *
 * Says FROZEN, not "old", when the connection is gone. Those are different
 * claims: an old price is a fact about a number, a frozen one is a fact about
 * what we can know, and only the second means we have stopped watching.
 */
function feedLine(feed: FeedHealth): string {
  if (feed.state === 'connected') {
    return 'Price feed: connected.';
  }
  const down = feed.downForMs === undefined ? '' : ` for ${describeDuration(feed.downForMs)}`;
  const attempts =
    feed.reconnectAttempt > 0 ? ` ${feed.reconnectAttempt} reconnect attempt(s) so far.` : '';
  const reason = feed.reason === undefined ? '' : ` ${feed.reason}`;
  return (
    `Price feed: ${feed.state.toUpperCase()}${down}. Every price I hold is frozen at ` +
    `whatever it was when the connection dropped, so I cannot assess anything and ` +
    `will not act.${attempts}${reason}`
  );
}

/**
 * The position-source line.
 *
 * `awaiting-snapshot` gets its own sentence rather than being folded in with
 * `stale`, because "I have not been told what is open yet" is not the same as
 * "what I was told may be wrong" — and neither of them is "you have no
 * positions".
 */
function positionsLine(positions: PositionSourceStatus): string {
  const age = `Last confirmed ${describeDuration(positions.ageMs)} ago.`;
  switch (positions.state) {
    case 'live':
      return `Positions: live. ${age}`;
    case 'awaiting-snapshot':
      return (
        'Positions: AWAITING SNAPSHOT. I am connected but have not been told what is ' +
        'open yet. This is not the same as having no positions.' +
        (positions.reason === undefined ? '' : ` ${positions.reason}`)
      );
    case 'stale':
      return (
        `Positions: UNTRUSTED. The set is frozen or may be incomplete, so a position ` +
        `here may already be closed and one that is open may be missing. ${age}` +
        (positions.reason === undefined ? '' : ` ${positions.reason}`)
      );
  }
}

/**
 * The price-age block, per market.
 *
 * Listed per market rather than summarised, because age is a per-market fact:
 * one quiet market among five busy ones is normal, and five quiet ones at once
 * is worth a look even though neither is a fault.
 */
function priceAgeLines(assessments: readonly RiskAssessment[]): string[] {
  if (assessments.length === 0) return [];
  const lines = ['Price age by market:'];
  for (const assessment of [...assessments].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    lines.push(
      assessment.priceAgeMs === undefined
        ? `  ${assessment.symbol}: no price has ever arrived`
        : `  ${assessment.symbol}: ${describeDuration(assessment.priceAgeMs)} old`,
    );
  }
  return lines;
}

/**
 * The headline.
 *
 * Blind states come first and say so in the first three words. Someone who reads
 * only the first line of this message must not come away reassured while we
 * cannot see.
 */
function headline(input: StatusInput): string {
  const feedDown = input.feed.state !== 'connected';
  const positionsUsable = input.positions.state === 'live';
  if (!positionsUsable && feedDown) {
    return 'PerpGuard is BLIND: I cannot trust your position list and the price feed is down.';
  }
  if (!positionsUsable) {
    return 'PerpGuard is BLIND: I cannot trust your position list right now.';
  }
  if (feedDown) {
    return 'PerpGuard is BLIND: the price feed is down.';
  }
  const count = input.assessments.length;
  if (count === 0) {
    return 'PerpGuard is watching. No open positions.';
  }
  return `PerpGuard is watching ${count} position${count === 1 ? '' : 's'}.`;
}

/** The whole `/status` reply. */
export function renderStatus(input: StatusInput): string {
  const lines = [
    headline(input),
    `Network: ${input.network}.`,
    feedLine(input.feed),
    positionsLine(input.positions),
  ];

  const states = input.assessments.map((a) => `${a.symbol} ${a.state}`).sort();
  if (states.length > 0) lines.push(`Current: ${states.join(', ')}.`);

  lines.push(...priceAgeLines(input.assessments));

  // Said last, so it qualifies everything above rather than being read as a
  // footnote to the price ages alone.
  if (input.feed.state !== 'connected' || input.positions.state !== 'live') {
    lines.push(
      'I am still watching and will keep alerting on what I last knew, but the ' +
        'numbers above are the last ones I could stand behind, not current ones.',
    );
  }

  return lines.join('\n');
}
