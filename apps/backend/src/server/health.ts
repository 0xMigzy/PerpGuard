/**
 * What `/health` says, as a pure function.
 *
 * THE RULE THIS FILE EXISTS FOR: a monitor that has gone blind must never look
 * healthy. Every input that can stop us seeing degrades the whole report and
 * names itself while doing it, because "DEGRADED" on its own sends someone
 * looking in the wrong place — and the two blind causes here, a dead price feed
 * and an untrustworthy position set, have completely different fixes.
 *
 * Degrading is deliberately generous. A component we could not ask about is
 * degraded, not fine: not having looked is not the same as having looked and
 * found nothing wrong. The only state that does not degrade is
 * `not-configured`, which says a subsystem was never asked for at all.
 *
 * Pure: every number is passed in. Nothing here reads a clock, a socket or a
 * database, which is what makes each blind case testable without one.
 */
import type {
  FeedHealth,
  IndexerHealth,
  NetworkName,
  PositionSourceStatus,
} from '@perpguard/shared';
import type { RiskAssessment } from '../risk/types.ts';

/**
 * How one subsystem is doing.
 *
 * `not-configured` is NOT a synonym for healthy. It means the process was never
 * asked to run this part — no indexer database, no bot token — and it is
 * reported so the absence is visible rather than inferred from a missing key.
 */
export type ComponentState = 'ok' | 'degraded' | 'not-configured';

export interface ComponentReport {
  readonly state: ComponentState;
  /** Safe to render. Present whenever the state is not `ok`. */
  readonly detail?: string;
  /** Anything worth showing next to the verdict. */
  readonly [key: string]: unknown;
}

export type OverallStatus = 'OK' | 'DEGRADED';

/** Where the trading session is, asked of {@link TradingSession}. */
export type TradingSessionState =
  /** Signed in; the position set is arriving. */
  | 'signed-in'
  /** First attempt in flight. */
  | 'connecting'
  /** Sign-in failed and is being retried. Never terminal — we do not exit. */
  | 'retrying'
  /** No API credentials were supplied, so there is nothing to sign in with. */
  | 'not-configured';

export interface TradingSessionStatus {
  readonly state: TradingSessionState;
  /** Safe to render; never contains a key, a secret or a token. */
  readonly reason?: string;
  readonly attempt: number;
  readonly accountId?: number;
  /** `fw` from the account snapshot. False means forwarded orders are refused. */
  readonly forwardingAllowed?: boolean;
}

/** What the alert delivery path has actually managed lately. */
export interface AlertDeliveryStatus {
  /** False when no transport is wired: alerts have nowhere to go. */
  readonly transportConfigured: boolean;
  /** Why there is no transport. Present only when there is none. */
  readonly transportReason?: string;
  /** Rows are kept where a restart does not lose them. */
  readonly durableLog: boolean;
  /** Why they are not, when they are not. Safe to render. */
  readonly durableReason?: string;
  readonly delivered: number;
  readonly failed: number;
  readonly lastDeliveredAtMs?: number;
  /** e.g. `BTC DANGER`. Enough to recognise the alert without quoting it. */
  readonly lastDelivered?: string;
  readonly lastFailureAtMs?: number;
  readonly lastFailure?: string;
}

export interface HealthInput {
  /** The ONE network this process assesses. */
  readonly network: NetworkName;
  readonly startedAtMs: number;
  readonly nowMs: number;
  readonly feed: FeedHealth;
  readonly positions: PositionSourceStatus;
  /** Whatever the loop currently holds. Empty is meaningful only when live. */
  readonly assessments: readonly RiskAssessment[];
  readonly trading: TradingSessionStatus;
  readonly alerts: AlertDeliveryStatus;
  /** Undefined when no indexer database was configured. */
  readonly indexer: IndexerHealth | undefined;
  /**
   * Whether the startup gate ever opened.
   *
   * False means we are still waiting for the first position snapshot, or gave
   * up waiting. Either way nothing has been assessed yet, and a report that
   * said OK would be saying so about a loop that has not run.
   */
  readonly assessing: boolean;
  /**
   * Every linked account's session, when the process runs a registry. The
   * `trading`/`positions`/`assessing` fields above describe the primary
   * (environment) account; this lists all of them, each with its own verdict,
   * so one account's socket dropping is visible as THAT account's problem.
   */
  readonly sessions?: readonly SessionHealthInput[];
}

export interface SessionHealthInput {
  readonly accountId: number;
  readonly trading: TradingSessionStatus;
  readonly positions: PositionSourceStatus;
  readonly assessing: boolean;
  readonly tracked: number;
  readonly mismatch?: string;
}

export interface HealthReport {
  readonly status: OverallStatus;
  readonly network: NetworkName;
  readonly uptimeMs: number;
  readonly startedAt: string;
  readonly at: string;
  /** Every degraded component's detail, so one read explains the verdict. */
  readonly reasons: readonly string[];
  readonly components: {
    readonly process: ComponentReport;
    readonly feed: ComponentReport;
    readonly positions: ComponentReport;
    readonly trading: ComponentReport;
    readonly alerts: ComponentReport;
    readonly indexer: ComponentReport;
    readonly risk: ComponentReport;
    /** Present when the process runs account sessions. */
    readonly sessions?: ComponentReport;
  };
}

/**
 * One line per linked account: connected, retrying, or blind, and why.
 *
 * Degraded when ANY session is, naming it: the account whose socket dropped is
 * the one its owner needs to hear about, and a roll-up that averaged it into
 * "mostly fine" would hide exactly that.
 */
function sessionsComponent(sessions: readonly SessionHealthInput[]): ComponentReport {
  const accounts: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const s of sessions) {
    const trading = tradingComponent(s.trading);
    const positions = positionsComponent(s.positions);
    const state = s.mismatch !== undefined || trading.state === 'degraded' || positions.state === 'degraded' || !s.assessing ? 'degraded' : 'ok';
    const connected = s.trading.state === 'signed-in';
    const blind = s.positions.state !== 'live';
    accounts[String(s.accountId)] = {
      state,
      connected,
      retrying: s.trading.state === 'retrying',
      blind,
      tracked: s.tracked,
      ...(trading.detail === undefined ? {} : { trading: trading.detail }),
      ...(positions.detail === undefined ? {} : { positions: positions.detail }),
      ...(s.mismatch === undefined ? {} : { mismatch: s.mismatch }),
    };
    if (state === 'degraded') {
      problems.push(`account ${s.accountId}: ${s.mismatch ?? trading.detail ?? positions.detail ?? (s.assessing ? 'degraded' : 'not yet assessing')}`);
    }
  }
  const base = { count: sessions.length, accounts };
  return problems.length === 0 ? { state: 'ok', ...base } : { state: 'degraded', ...base, detail: problems.join('; ') };
}

function feedComponent(feed: FeedHealth): ComponentReport {
  if (feed.state === 'connected') {
    return { state: 'ok', connection: feed.state };
  }
  return {
    state: 'degraded',
    connection: feed.state,
    reconnectAttempt: feed.reconnectAttempt,
    ...(feed.downForMs === undefined ? {} : { downForMs: feed.downForMs }),
    detail:
      feed.reason ??
      `the price feed is ${feed.state}, so every price held is frozen at whatever it was ` +
        `when the connection dropped`,
  };
}

function positionsComponent(positions: PositionSourceStatus): ComponentReport {
  const base = {
    source: positions.state,
    ...(positions.ageMs === undefined ? {} : { ageMs: positions.ageMs }),
  };
  if (positions.state === 'live') return { state: 'ok', ...base };
  return {
    state: 'degraded',
    ...base,
    detail:
      positions.reason ??
      (positions.state === 'awaiting-snapshot'
        ? 'no position snapshot has arrived yet, so we have not been told what is open'
        : 'the position set is frozen or may be incomplete, so a closed position could ' +
          'still show as open'),
  };
}

function tradingComponent(trading: TradingSessionStatus): ComponentReport {
  const base = {
    session: trading.state,
    attempt: trading.attempt,
    ...(trading.accountId === undefined ? {} : { accountId: trading.accountId }),
    ...(trading.forwardingAllowed === undefined
      ? {}
      : { forwardingAllowed: trading.forwardingAllowed }),
  };
  if (trading.state === 'not-configured') {
    return {
      state: 'not-configured',
      ...base,
      detail:
        trading.reason ??
        'no Perpl API credentials were supplied, so there is no account to watch',
    };
  }
  if (trading.state === 'signed-in') {
    // `fw` false is not a sign-in failure, but it does mean every action would
    // come back sr 34, and that is worth saying before somebody taps a button.
    if (trading.forwardingAllowed === false) {
      return {
        state: 'degraded',
        ...base,
        detail:
          'the account does not permit API-key-forwarded orders (fw is false). ' +
          'The owner wallet must call allowOrderForwarding(true). Monitoring continues.',
      };
    }
    return { state: 'ok', ...base };
  }
  return {
    state: 'degraded',
    ...base,
    detail: trading.reason ?? `the trading session is ${trading.state}`,
  };
}

/**
 * The alert path.
 *
 * NO TRANSPORT IS A DEGRADED STATE, not a configuration note. An alerts engine
 * with nowhere to send is a risk monitor whose warnings vanish, which looks
 * exactly like a risk monitor with nothing to warn about.
 */
function alertsComponent(alerts: AlertDeliveryStatus): ComponentReport {
  const base = {
    delivered: alerts.delivered,
    failed: alerts.failed,
    durableLog: alerts.durableLog,
    ...(alerts.lastDeliveredAtMs === undefined
      ? {}
      : { lastDeliveredAt: new Date(alerts.lastDeliveredAtMs).toISOString() }),
    ...(alerts.lastDelivered === undefined ? {} : { lastDelivered: alerts.lastDelivered }),
    ...(alerts.lastFailureAtMs === undefined
      ? {}
      : { lastFailureAt: new Date(alerts.lastFailureAtMs).toISOString() }),
    ...(alerts.lastFailure === undefined ? {} : { lastFailure: alerts.lastFailure }),
  };

  if (!alerts.transportConfigured) {
    return {
      state: 'degraded',
      ...base,
      detail:
        alerts.transportReason ??
        'no alert transport is wired, so any warning this process produces goes nowhere',
    };
  }
  if (!alerts.durableLog) {
    return {
      state: 'degraded',
      ...base,
      detail:
        'alert history is kept in memory, so a restart loses the record of what was sent ' +
        `and what failed${alerts.durableReason === undefined ? '' : `: ${alerts.durableReason}`}`,
    };
  }
  if (alerts.lastFailure !== undefined) {
    return {
      state: 'degraded',
      ...base,
      detail: `the last alert delivery failed: ${alerts.lastFailure}`,
    };
  }
  return { state: 'ok', ...base };
}

function indexerComponent(indexer: IndexerHealth | undefined): ComponentReport {
  if (indexer === undefined) {
    return {
      state: 'not-configured',
      detail: 'no indexer database was configured, so analytics lag is not being watched',
    };
  }
  const base = {
    indexer: indexer.state,
    blocksBehind: indexer.blocksBehind,
    headIsIndependent: indexer.headIsIndependent,
  };
  // `serveAsCurrent` is the indexer's own answer to "may these figures be shown
  // as now", and it is false for lagging, halted and unverified alike. Reusing
  // it here rather than re-deriving keeps one definition of caught-up.
  if (indexer.serveAsCurrent) return { state: 'ok', ...base };
  return {
    state: 'degraded',
    ...base,
    detail: indexer.reason ?? `the indexer is ${indexer.state}`,
  };
}

function riskComponent(input: HealthInput): ComponentReport {
  const states: Record<string, number> = {};
  for (const assessment of input.assessments) {
    states[assessment.state] = (states[assessment.state] ?? 0) + 1;
  }
  const base = { tracked: input.assessments.length, states };

  if (!input.assessing) {
    return {
      state: 'degraded',
      ...base,
      detail:
        'the risk loop has not begun assessing: it is still waiting for the first position ' +
        'snapshot, so nothing here has been evaluated',
    };
  }
  return { state: 'ok', ...base };
}

/**
 * Assemble the report.
 *
 * The overall status is DEGRADED if ANY component is, with no weighting and no
 * majority: one blind input is enough, because one blind input is enough to
 * miss a liquidation.
 */
export function buildHealth(input: HealthInput): HealthReport {
  const components = {
    process: {
      state: 'ok' as const,
      pid: process.pid,
      node: process.version,
    },
    feed: feedComponent(input.feed),
    positions: positionsComponent(input.positions),
    trading: tradingComponent(input.trading),
    alerts: alertsComponent(input.alerts),
    indexer: indexerComponent(input.indexer),
    risk: riskComponent(input),
    ...(input.sessions === undefined ? {} : { sessions: sessionsComponent(input.sessions) }),
  };

  const reasons: string[] = [];
  for (const [name, report] of Object.entries(components)) {
    if (report.state !== 'degraded') continue;
    reasons.push(`${name}: ${report.detail ?? 'no detail given'}`);
  }

  return {
    status: reasons.length === 0 ? 'OK' : 'DEGRADED',
    network: input.network,
    uptimeMs: Math.max(0, input.nowMs - input.startedAtMs),
    startedAt: new Date(input.startedAtMs).toISOString(),
    at: new Date(input.nowMs).toISOString(),
    reasons,
    components,
  };
}
