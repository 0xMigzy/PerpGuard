/**
 * What the bot is allowed to know about the risk loop.
 *
 * A narrow read-only port rather than the `RiskLoop` class: the bot renders and
 * asks questions, and must never be able to make the loop do anything. The loop
 * satisfies `snapshot`, `positionsStatus` and `network` directly; `feedStatus`
 * is supplied by whoever wired the loop, since that is the same function the
 * loop itself was constructed with.
 *
 * Every method is SYNCHRONOUS. Something deciding whether it can see must not
 * have to await the answer — an awaited health check is a health check that can
 * hang, and a `/status` that hangs is indistinguishable from a bot that is down.
 */
import type { FeedHealth, NetworkName, PositionSourceStatus } from '@perpguard/shared';
import type { RiskAssessment } from '@perpguard/backend/risk';

export interface RiskView {
  /** The ONE network this loop assesses. */
  readonly network: NetworkName;
  snapshot(): readonly RiskAssessment[];
  feedStatus(): FeedHealth;
  positionsStatus(): PositionSourceStatus;
}
