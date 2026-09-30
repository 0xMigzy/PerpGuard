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
import type { MarginProjectionResult, RiskAssessment } from '@perpguard/backend/risk';

export interface RiskView {
  /** The ONE network this loop assesses. */
  readonly network: NetworkName;
  snapshot(): readonly RiskAssessment[];
  feedStatus(): FeedHealth;
  positionsStatus(): PositionSourceStatus;
  /**
   * Where a position lands if a CUSTOM amount of margin is added.
   *
   * Asked of the loop rather than worked out here, because the bot must not do
   * risk maths. An assessment carries the two top-ups PerpGuard computed but not
   * the position they were computed from, so a buffer for an amount the user
   * typed is not derivable from what the bot holds — and deriving it anyway would
   * put a second implementation of the liquidation formula behind a button.
   *
   * Returns a REASON when it cannot answer, which the caller is expected to show.
   * A position we are blind on is refused outright: see the note on
   * `MarginProjectionResult`.
   */
  projectAddMargin(marketId: number, amountCNS: bigint): MarginProjectionResult;
}
