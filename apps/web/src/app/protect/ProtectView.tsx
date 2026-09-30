'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrepareRequest, Prepared, ProtectPosition, ProtectProgress, ProtectSnapshot, ProtectStress } from '@perpguard/backend/protect';
import { describeError, protect } from '@/lib/api.ts';
import { formatAge, formatAusd, formatPct, formatPriceAsServed, formatSignedAusd } from '@/lib/format.ts';
import { closestToLiquidation, inFlightSource, meterPosition, stepsFor, tierOf, venueDisagrees, type Tier } from '@/lib/protect.ts';
import { COLORS } from '@/lib/theme.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { ProtectGate } from '@/components/ProtectGate.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';

const SNAPSHOT_POLL_MS = 3_000;
const PROGRESS_POLL_MS = 500;

const TIER_COLOR: Record<Tier, string> = { past: COLORS.danger, danger: COLORS.danger, watch: COLORS.watch, safe: COLORS.safe, blind: COLORS.muted };
const TIER_LABEL: Record<Tier, string> = { past: 'PAST LIQUIDATION', danger: 'DANGER', watch: 'WATCH', safe: 'SAFE', blind: 'BLIND' };

type Snapshot = ProtectSnapshot & { readonly notes: readonly string[] };

export function ProtectView() {
  return (
    <ProtectGate title="Protect" subtitle="Your positions, their runway, and the button that adds margin before the venue takes it.">
      {(_session, signOut) => <Account onSignedOut={signOut} />}
    </ProtectGate>
  );
}

// ── the account ─────────────────────────────────────────────────────────────

function Account({ onSignedOut }: { readonly onSignedOut: () => void }) {
  const snap = usePoll(protect.positions, SNAPSHOT_POLL_MS, 'protect:positions');
  const s = snap.data;
  const [confirm, setConfirm] = useState<Prepared | undefined>(undefined);
  const [chooser, setChooser] = useState<number | undefined>(undefined);
  const mine = useRef(new Set<string>());

  const signOut = onSignedOut;

  const blind = s !== undefined && (s.feed.state !== 'connected' || s.positionsStatus.state !== 'live');
  const worst = s === undefined ? undefined : closestToLiquidation(s.positions);
  const flagged = s === undefined ? 0 : s.positions.filter((p) => tierOf(p.state) === 'danger' || tierOf(p.state) === 'past').length;
  const marginAtRisk = s === undefined ? 0 : s.positions.reduce((sum, p) => sum + p.marginAusd, 0);
  const notional = s === undefined ? 0 : s.positions.reduce((sum, p) => sum + p.notionalAusd, 0);

  const open = useCallback((request: PrepareRequest) => {
    setChooser(undefined);
    return protect.prepare(request).then(setConfirm);
  }, []);

  return (
    <>
      <PageHeader
        title="Protect"
        thin={s === undefined ? undefined : `account ${s.accountId ?? '?'} on ${s.network}`}
        subtitle="Isolated margin: each position stands alone. Your free AUSD is never pulled in to rescue one."
        right={
          <>
            {s !== undefined && (
              <span className="inline-flex items-center gap-2 rounded-[9px] border border-border2 bg-card px-3 py-[6px] text-[12.5px] text-muted">
                <i className="inline-block h-[8px] w-[8px] rounded-full" style={{ background: blind ? COLORS.danger : COLORS.safe }} />
                {blind ? 'Blind' : 'Positions live'}
                {worst?.priceAgeMs !== undefined && !blind && ` · price ${formatAge(worst.priceAgeMs)} old`}
              </span>
            )}
            <button type="button" className="btn" onClick={signOut}>
              Sign out
            </button>
          </>
        }
      />

      <ErrorNote error={snap.error} what="Your positions" />
      {s !== undefined && blind && (
        <div role="alert" className="mb-4 rounded-[10px] border border-danger/40 bg-danger/10 px-4 py-3 text-[13px]">
          <b className="text-danger">PerpGuard is blind.</b>{' '}
          <span className="text-muted">
            {s.positionsStatus.state !== 'live' && `The position list is ${s.positionsStatus.state}${s.positionsStatus.reason === undefined ? '' : `: ${s.positionsStatus.reason}`}. `}
            {s.feed.state !== 'connected' && `The price feed is ${s.feed.state}${s.feed.reason === undefined ? '' : `: ${s.feed.reason}`}. `}
            The numbers below are the last ones it could stand behind, not current ones, and no action will be sent while this holds.
          </span>
        </div>
      )}
      {s !== undefined && s.forwardingAllowed === false && (
        <div role="alert" className="mb-4 rounded-[10px] border border-watch/40 bg-watch/10 px-4 py-3 text-[13px]">
          <b className="text-watch">This account does not allow API-forwarded orders.</b>{' '}
          <span className="text-muted">Every action here would be refused (sr 34). The owner wallet enables it with allowOrderForwarding(true).</span>
        </div>
      )}

      {/* ── the worst position, up top ──────────────────────────────────── */}
      {s !== undefined && worst !== undefined && (tierOf(worst.state) === 'danger' || tierOf(worst.state) === 'past') && (
        <div className="mb-4 flex gap-3 rounded-[12px] border border-watch/40 bg-watch/10 px-[18px] py-4">
          <span className="mt-[2px] text-watch" aria-hidden="true">
            ⚠
          </span>
          <div className="min-w-0 flex-1">
            <b>{worst.title} — {worst.bufferText}</b>
            <p className="mt-1 mb-2 text-[13px] text-muted">{worst.lines.slice(0, 2).join(' ')}</p>
            <OptionButtons position={worst} disabled={blind} onPick={open} onCustom={() => setChooser(worst.marketId)} mine={mine.current} />
          </div>
        </div>
      )}

      {/* ── tiles ───────────────────────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {s === undefined ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[112px] w-full" />)
        ) : (
          <>
            <Tile
              label="Free balance"
              value={s.freeBalance.known ? `≥ ${formatAusd(s.freeBalance.floorAusd)}` : 'unknown'}
              sub={s.freeBalance.known ? 'a floor, not your balance' : s.freeBalance.reason}
              note="Never used to rescue a position automatically"
            />
            <Tile label="Margin at risk" value={formatAusd(marginAtRisk)} sub={`posted across ${s.positions.length} position${s.positions.length === 1 ? '' : 's'}`} note={`Notional ${formatAusd(notional)}`} />
            <Tile
              label="Closest to liquidation"
              value={worst === undefined ? '—' : worst.liqBufferPct! < 0 ? 'past liquidation' : formatPct(worst.liqBufferPct!, 2)}
              valueColor={worst === undefined ? undefined : TIER_COLOR[tierOf(worst.state)]}
              sub={worst === undefined ? (s.positions.length === 0 ? 'no open positions' : 'nothing assessable') : `${worst.symbol} ${worst.side ?? ''} · ${flagged} of ${s.positions.length} flagged`}
              note={
                worst === undefined
                  ? ''
                  : `liquidation ${worst.liquidationPrice === undefined ? '—' : worst.liquidationPrice <= 0 ? 'none left to reach' : formatPriceAsServed(worst.liquidationPrice)}, mark ${formatPriceAsServed(worst.markPrice)}`
              }
            />
          </>
        )}
      </section>

      {/* ── positions ───────────────────────────────────────────────────── */}
      {s !== undefined && s.positions.length === 0 && (
        <div className="card mb-4 px-[18px] py-5 text-[13px] text-muted">
          {s.positionsStatus.state === 'live' ? 'No open positions on this account. Nothing to protect right now.' : 'I have not been told what is open, which is not the same as having no positions.'}
        </div>
      )}
      {s?.notes.map((n) => (
        <div key={n} className="mb-3 text-[12.5px] text-muted">
          {n}
        </div>
      ))}
      {s?.positions.map((p) => (
        <PositionCard
          key={p.marketId}
          position={p}
          thresholds={s.thresholds}
          blind={blind}
          chooserOpen={chooser === p.marketId}
          onChooser={(v) => setChooser(v ? p.marketId : undefined)}
          onPick={open}
          onKill={() => void open({ kind: 'kill-switch' })}
          mine={mine.current}
          confirm={confirm?.marketId === p.marketId || (confirm?.kind === 'kill-switch' && s.positions[0]?.marketId === p.marketId) ? confirm : undefined}
          onConfirmed={(key) => mine.current.add(key)}
          onCloseConfirm={() => setConfirm(undefined)}
        />
      ))}

      {/* ── stress + thresholds ────────────────────────────────────────── */}
      {s !== undefined && (
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StressCard enabled={s.positions.length > 0 && !blind} />
          <div className="card px-[18px] py-4">
            <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
              <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Alert thresholds</h2>
              <span className="text-[12.5px] text-muted">Condition vs current</span>
            </div>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-[11.5px] uppercase tracking-[0.06em] text-muted">
                  <th className="py-[6px] text-left font-semibold">Rule</th>
                  <th className="py-[6px] text-right font-semibold">Condition</th>
                  <th className="py-[6px] text-right font-semibold">Current</th>
                </tr>
              </thead>
              <tbody>
                <ThresholdRow rule="Danger" condition={`buffer < ${formatPct(s.thresholds.dangerEnterPct, 0)}`} current={worst?.bufferText ?? '—'} bad={worst !== undefined && worst.liqBufferPct! < s.thresholds.dangerEnterPct} />
                <ThresholdRow rule="Watch" condition={`buffer < ${formatPct(s.thresholds.watchEnterPct, 0)}`} current={worst?.bufferText ?? '—'} bad={worst !== undefined && worst.liqBufferPct! < s.thresholds.watchEnterPct} />
                <ThresholdRow rule="All-clear" condition={`buffer > ${formatPct(s.thresholds.watchExitPct, 0)} for ${Math.round(s.thresholds.minDwellMs / 60_000)} min`} current="held on fresh prices only" bad={false} />
                <ThresholdRow rule="Position list" condition="live" current={`${s.positionsStatus.state}${s.positionsStatus.ageMs === undefined ? '' : ` · ${formatAge(s.positionsStatus.ageMs)} old`}`} bad={s.positionsStatus.state !== 'live'} />
                <ThresholdRow rule="Price feed" condition="connected" current={s.feed.state} bad={s.feed.state !== 'connected'} />
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Tile({ label, value, sub, note, valueColor }: { readonly label: string; readonly value: string; readonly sub: string; readonly note: string; readonly valueColor?: string | undefined }) {
  return (
    <div className="card px-[18px] pt-4 pb-3">
      <div className="text-[12.5px] font-medium text-muted">{label}</div>
      <div className="num mt-2 mb-[4px] text-[28px] leading-[1.1] font-bold tracking-[-0.035em]" style={valueColor === undefined ? undefined : { color: valueColor }}>
        {value}
      </div>
      <div className="text-[12px] font-medium text-muted">{sub}</div>
      <div className="mt-[2px] text-[12px] text-muted2">{note}</div>
    </div>
  );
}

function ThresholdRow({ rule, condition, current, bad }: { readonly rule: string; readonly condition: string; readonly current: string; readonly bad: boolean }) {
  return (
    <tr className="border-t border-border">
      <td className="py-[7px]">{rule}</td>
      <td className="num py-[7px] text-right text-muted">{condition}</td>
      <td className={`num py-[7px] text-right ${bad ? 'text-danger' : 'text-safe'}`}>{current}</td>
    </tr>
  );
}

// ── option buttons: the two computed top-ups and the custom amount ──────────

function OptionButtons({
  position: p,
  disabled,
  onPick,
  onCustom,
  mine,
}: {
  readonly position: ProtectPosition;
  readonly disabled: boolean;
  readonly onPick: (request: PrepareRequest) => Promise<void>;
  readonly onCustom: () => void;
  readonly mine: ReadonlySet<string>;
}) {
  const unavailable = p.availability !== undefined && !p.availability.actionable ? p.availability.reason : p.availability === undefined ? 'PerpGuard has not been told whether this market can be acted on' : undefined;
  if (p.inFlight !== undefined) return <InFlightNote position={p} mine={mine} />;
  const off = disabled || unavailable !== undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {p.options.map((o, i) => (
        <button key={o.intent} type="button" className={`btn ${i === 0 ? 'primary' : ''} num`} disabled={off} title={unavailable} onClick={() => void onPick({ kind: 'add-margin', marketId: p.marketId, intent: o.intent })}>
          {o.label}
        </button>
      ))}
      <button type="button" className="btn" disabled={off} title={unavailable} onClick={onCustom}>
        Custom amount
      </button>
      {unavailable !== undefined && <span className="text-[12px] text-muted">Actions unavailable: {unavailable}</span>}
    </div>
  );
}

function InFlightNote({ position: p, mine }: { readonly position: ProtectPosition; readonly mine: ReadonlySet<string> }) {
  const source = inFlightSource(p.inFlight!.idempotencyKey, mine);
  return (
    <div className="rounded-[9px] border border-border2 bg-card2 px-3 py-2 text-[12.5px] text-muted">
      <b className="text-text">An action on {p.symbol} is in flight</b> since {formatAge(Date.now() - p.inFlight!.sinceMs)} ago,{' '}
      {source === 'here' ? 'started on this page' : 'started from Telegram or another session'}. The buttons come back when it settles: a second action sent behind the
      first is how the same top-up lands twice, so PerpGuard refuses rather than queues.
    </div>
  );
}

// ── one position ────────────────────────────────────────────────────────────

function PositionCard(props: {
  readonly position: ProtectPosition;
  readonly thresholds: ProtectSnapshot['thresholds'];
  readonly blind: boolean;
  readonly chooserOpen: boolean;
  readonly onChooser: (open: boolean) => void;
  readonly onPick: (request: PrepareRequest) => Promise<void>;
  readonly onKill: () => void;
  readonly mine: ReadonlySet<string>;
  readonly confirm: Prepared | undefined;
  readonly onConfirmed: (key: string) => void;
  readonly onCloseConfirm: () => void;
}) {
  const { position: p, thresholds: t } = props;
  const tier = tierOf(p.state);
  const color = TIER_COLOR[tier];
  const marker = meterPosition(p.liqBufferPct, t.dangerEnterPct, t.watchEnterPct);
  // A liquidation price at or below zero is not a price: the collateral exceeds
  // anything the market could take away. Said in words, as the alerts renderer
  // does, rather than printed as a negative figure.
  const liqText = p.liquidationPrice === undefined ? '—' : p.liquidationPrice <= 0 ? 'none left to reach' : formatPriceAsServed(p.liquidationPrice);
  const away = p.liquidationPrice === undefined || p.liquidationPrice <= 0 ? undefined : Math.abs(p.markPrice - p.liquidationPrice);
  const [custom, setCustom] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const unavailable = p.availability !== undefined && !p.availability.actionable ? p.availability.reason : undefined;
  const off = props.blind || unavailable !== undefined || p.inFlight !== undefined;

  const pick = (request: PrepareRequest) => {
    setProblem(undefined);
    return props.onPick(request).catch((error) => setProblem(describeError(error)));
  };

  return (
    <div className="card mb-4 overflow-hidden" style={{ borderColor: tier === 'safe' ? undefined : `${color}55` }}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-[18px] py-3">
        <b className="text-[16px] tracking-[-0.01em]">{p.symbol}</b>
        {p.side !== undefined && (
          <span className={`rounded-[6px] px-[7px] py-[2px] text-[10.5px] font-bold uppercase tracking-[0.05em] ${p.side === 'long' ? 'bg-safe/15 text-safe' : 'bg-danger/15 text-danger'}`}>{p.side}</span>
        )}
        <span className="num text-[13px] text-muted">
          {p.size === undefined ? '' : `${formatPriceAsServed(p.size)} `}
          {p.entryPrice === undefined ? '' : `@ ${formatPriceAsServed(p.entryPrice)}`}
          {p.leverage === undefined ? '' : ` · ${p.leverage}×`}
        </span>
        <span className="ml-auto rounded-[6px] px-[8px] py-[3px] text-[10.5px] font-bold tracking-[0.05em]" style={{ background: `${color}26`, color }}>
          {TIER_LABEL[tier]}
        </span>
      </div>
      <div className="px-[18px] py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="eyebrow">Liquidation runway</span>
          <b className="num" style={{ color }}>
            {p.liqBufferPct === undefined ? p.bufferText : p.liqBufferPct < 0 ? 'past liquidation' : `${formatPct(p.liqBufferPct, 2)}${away === undefined ? '' : ` · ${formatPriceAsServed(away)} away`}`}
          </b>
        </div>
        <div className="relative mt-2 h-[8px] w-full overflow-hidden rounded-full" aria-hidden="true">
          <div className="absolute inset-y-0 left-0 bg-danger/60" style={{ width: '20%' }} />
          <div className="absolute inset-y-0 bg-watch/60" style={{ left: '20%', width: '30%' }} />
          <div className="absolute inset-y-0 bg-safe/50" style={{ left: '50%', right: 0 }} />
          <div className="absolute top-[-2px] h-[12px] w-[3px] rounded-[2px] bg-text shadow-[0_0_0_2px_#0F1118]" style={{ left: `calc(${(marker * 100).toFixed(1)}% - 1px)` }} />
        </div>
        <div className="num mt-1 flex justify-between text-[11px] text-muted2">
          <span>Liq {liqText}</span>
          <span>{formatPct(t.dangerEnterPct, 0)}</span>
          <span>{formatPct(t.watchEnterPct, 0)}</span>
          <span>20%+</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-5">
          <Fact label="Mark" value={formatPriceAsServed(p.markPrice)} />
          <Fact label="Notional" value={formatAusd(p.notionalAusd)} />
          <Fact label="Margin" value={formatAusd(p.marginAusd)} />
          <Fact label="Maint. margin" value={formatAusd(p.maintenanceMarginAusd)} />
          <Fact label="uPnL" value={formatSignedAusd(p.unrealisedPnlAusd)} color={p.unrealisedPnlAusd > 0 ? COLORS.safe : p.unrealisedPnlAusd < 0 ? COLORS.danger : undefined} />
        </div>
        {(p.priceIsOld || p.heldOnStalePrice) && <div className="mt-2 text-[12px] text-muted">{p.priceAgeMs === undefined ? 'price age unknown' : `Price is ${formatAge(p.priceAgeMs)} old`} · the severity is held, not softened, on an old price.</div>}
        {tier === 'blind' && <div className="mt-2 text-[12px] text-danger">{p.reason}</div>}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {p.inFlight !== undefined ? (
            <InFlightNote position={p} mine={props.mine} />
          ) : (
            <>
              <button type="button" className="btn primary" disabled={off || p.options.length === 0} title={unavailable ?? (p.options.length === 0 ? 'This position already has the room both options would buy; use a custom amount.' : undefined)} onClick={() => props.onChooser(!props.chooserOpen)}>
                Add margin
              </button>
              <button type="button" className="btn" disabled title="Reduce is not built yet. A proportional reduce leaves the liquidation price where it is; only keeping margin while reducing buys room, and that path has not been measured on the venue.">
                Reduce
              </button>
              <button type="button" className="btn" disabled={off} title={unavailable} onClick={() => void pick({ kind: 'close-position', marketId: p.marketId })}>
                Close
              </button>
              <button type="button" className="btn danger ml-auto" disabled={props.blind} onClick={props.onKill}>
                Kill switch
              </button>
            </>
          )}
        </div>
        {unavailable !== undefined && <div className="mt-2 text-[12px] text-muted">Actions unavailable on {p.availability?.network}: {unavailable}</div>}

        {props.chooserOpen && (
          <div className="mt-3 rounded-[10px] border border-border2 bg-card2 px-4 py-3">
            <div className="eyebrow mb-2">What a top-up buys</div>
            <div className="flex flex-col gap-2">
              {p.options.map((o) => (
                <button key={o.intent} type="button" className="btn num justify-start" onClick={() => void pick({ kind: 'add-margin', marketId: p.marketId, intent: o.intent })}>
                  {o.label}
                </button>
              ))}
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void pick({ kind: 'add-margin', marketId: p.marketId, intent: 'custom', amount: custom });
                }}
              >
                <input className="num min-w-0 flex-1 rounded-[9px] border border-border2 bg-page px-3 py-2 text-text outline-none placeholder:text-muted focus:border-accent" placeholder="Custom amount in AUSD, e.g. 250" value={custom} onChange={(e) => setCustom(e.target.value)} inputMode="decimal" />
                <button type="submit" className="btn" disabled={custom.trim() === ''}>
                  Price it
                </button>
              </form>
              <div className="text-[11.5px] text-muted2">Any amount goes through the same risk engine and the same confirmation as the two computed ones. Nothing is sent until you confirm.</div>
            </div>
          </div>
        )}
        {problem !== undefined && <div className="mt-2 text-[12.5px] text-danger">{problem}</div>}

        {props.confirm !== undefined && <ConfirmPanel prepared={props.confirm} onConfirmed={props.onConfirmed} onClose={props.onCloseConfirm} />}
      </div>
    </div>
  );
}

function Fact({ label, value, color }: { readonly label: string; readonly value: string; readonly color?: string | undefined }) {
  return (
    <div>
      <div className="text-[11px] font-medium tracking-[0.02em] text-muted uppercase">{label}</div>
      <div className="num mt-[1px] font-semibold" style={color === undefined ? undefined : { color }}>
        {value}
      </div>
    </div>
  );
}

// ── the confirmation and the outcome ────────────────────────────────────────

function ConfirmPanel({ prepared, onConfirmed, onClose }: { readonly prepared: Prepared; readonly onConfirmed: (key: string) => void; readonly onClose: () => void }) {
  const [key, setKey] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<ProtectProgress | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [current, setCurrent] = useState<Prepared>(prepared);
  useEffect(() => setCurrent(prepared), [prepared]);

  // Poll until settled. Nothing here decides an outcome; it renders what the backend says.
  useEffect(() => {
    if (key === undefined) return;
    let alive = true;
    const tick = async () => {
      try {
        const p = await protect.progress(key);
        if (!alive) return;
        setProgress(p);
        // The snapshot poll picks up the new margin on its own; nothing here
        // refreshes it, because a refresh would unmount this panel mid-outcome.
        if (p.stage === 'settled') return;
      } catch (error) {
        if (!alive) return;
        setProblem(describeError(error));
      }
      if (alive) setTimeout(() => void tick(), PROGRESS_POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [key]);

  const send = async (token: string) => {
    setProblem(undefined);
    setProgress(undefined);
    try {
      const { idempotencyKey } = await protect.execute(token);
      onConfirmed(idempotencyKey);
      setKey(idempotencyKey);
    } catch (error) {
      setProblem(describeError(error));
    }
  };

  const steps = stepsFor(progress);
  const outcome = progress?.stage === 'settled' ? progress.outcome : undefined;
  const sending = key !== undefined && outcome === undefined;
  const lastLine = current.lines.at(-1);

  return (
    <div className="mt-3 rounded-[10px] border border-accent/40 bg-card2 px-4 py-3">
      <h4 className="m-0 text-[14px] font-bold">{current.title}</h4>
      <div className="mt-1 text-[13px]">
        {current.lines.slice(0, -1).map((line, i) => (
          <div key={i} className={i === 0 ? 'num font-semibold' : 'text-muted'}>
            {line}
          </div>
        ))}
        {key === undefined && <div className="mt-1 font-semibold text-text">{lastLine}</div>}
      </div>

      {key !== undefined && (
        <ol className="mt-3 mb-0 list-none space-y-1 p-0 text-[12.5px]">
          {steps.map((step) => (
            <li key={step.label} className="flex items-start gap-2">
              <StepIcon status={step.status} />
              <span className={step.status === 'pending' ? 'text-muted2' : step.status === 'failed' ? 'text-watch' : 'text-text'}>
                {step.label}
                {step.note !== undefined && <span className="text-muted"> · {step.note}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}

      {outcome !== undefined && progress !== undefined && <Outcome progress={progress} onRetry={(token) => void send(token)} />}
      {problem !== undefined && <div className="mt-2 text-[12.5px] text-danger">{problem}</div>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {key === undefined ? (
          <>
            <button type="button" className={`btn ${current.kind === 'kill-switch' ? 'danger' : 'primary'}`} onClick={() => void send(current.token)}>
              {current.kind === 'kill-switch' ? 'Fire the kill switch' : 'Send'}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </>
        ) : sending ? (
          <span className="text-[12.5px] text-muted">Sending… nothing is reported as done until the position has been read.</span>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}

function StepIcon({ status }: { readonly status: 'pending' | 'active' | 'done' | 'failed' | 'skipped' }) {
  const cls =
    status === 'done' ? 'bg-safe' : status === 'active' ? 'bg-accent-hi animate-pulse' : status === 'failed' ? 'bg-watch' : status === 'skipped' ? 'bg-border2' : 'bg-border2';
  return <i className={`mt-[4px] inline-block h-[9px] w-[9px] flex-none rounded-full ${cls}`} aria-hidden="true" />;
}

function Outcome({ progress, onRetry }: { readonly progress: ProtectProgress; readonly onRetry: (token: string) => void }) {
  const o = progress.outcome!;
  if (o.kind === 'kill-switch') {
    return (
      <div className="mt-3 rounded-[9px] border border-border2 bg-card px-3 py-2 text-[13px]">
        <b style={{ color: o.complete ? COLORS.safe : COLORS.danger }}>{o.complete ? 'Kill switch complete.' : 'Kill switch PARTIAL.'}</b>
        <pre className="mt-1 mb-0 whitespace-pre-wrap font-sans text-[12.5px] text-muted">{o.text}</pre>
      </div>
    );
  }
  const headline = o.kind === 'applied' ? 'Applied.' : o.kind === 'not-applied' ? 'Not applied.' : o.kind === 'unknown' ? 'Unknown.' : 'Refused before sending.';
  const color = o.kind === 'applied' ? COLORS.safe : o.kind === 'unknown' ? COLORS.watch : COLORS.danger;
  const disagree = venueDisagrees(progress);
  return (
    <div className="mt-3 rounded-[9px] border border-border2 bg-card px-3 py-2 text-[13px]">
      <b style={{ color }}>{headline}</b> <span className="text-text">{o.text}</span>
      {o.nextStep !== undefined && <div className="mt-1 font-semibold text-watch">{o.nextStep}</div>}
      {o.reported !== undefined && o.reconciliation !== undefined && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div className={`rounded-[8px] border px-3 py-2 ${disagree ? 'border-watch/50' : 'border-border'}`}>
            <div className="eyebrow">Venue reported</div>
            <div className="num mt-1 font-semibold">{o.reported.status}{o.reported.reason === undefined ? '' : ` · ${o.reported.reason}`}</div>
            <div className="text-[12px] text-muted">{disagree ? 'Not trusted for this order type. Recorded, then set aside.' : 'A report, not the outcome.'}</div>
          </div>
          <div className={`rounded-[8px] border px-3 py-2 ${disagree ? 'border-safe/50' : 'border-border'}`}>
            <div className="eyebrow">Position says</div>
            <div className="num mt-1 font-semibold">
              {o.reconciliation.verdict} · {o.reconciliation.field} {o.reconciliation.before} → {o.reconciliation.after ?? 'gone'}
              {o.reconciliation.delta === undefined ? '' : ` (Δ ${o.reconciliation.delta}, requested ${o.reconciliation.requested})`}
            </div>
            <div className="text-[12px] text-muted">{disagree ? 'The evidence. One send, no resend.' : 'Read after the send; this is what counts.'}</div>
          </div>
        </div>
      )}
      {o.retryToken !== undefined && (
        <div className="mt-2">
          <button type="button" className="btn primary" onClick={() => onRetry(o.retryToken!)}>
            Send again
          </button>
          <span className="ml-2 text-[12px] text-muted">Safe: the position was read and had not moved, so nothing can land twice.</span>
        </div>
      )}
    </div>
  );
}

// ── the stress test ─────────────────────────────────────────────────────────

function StressCard({ enabled }: { readonly enabled: boolean }) {
  const [move, setMove] = useState(-5);
  const [result, setResult] = useState<ProtectStress | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const handle = setTimeout(() => {
      protect
        .stress(move / 100)
        .then((r) => {
          setResult(r);
          setError(undefined);
        })
        .catch(setError);
    }, 250);
    return () => clearTimeout(handle);
  }, [move, enabled]);
  const cover = useMemo(() => {
    if (result === undefined || !result.ok || !result.freeBalance.known || result.shortfallAusd <= 0) return undefined;
    return result.freeBalance.floorAusd / result.shortfallAusd;
  }, [result]);
  return (
    <div className="card px-[18px] py-4">
      <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
        <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Stress test</h2>
        <span className="text-[12.5px] text-muted">Numbers from the risk engine, not the browser</span>
      </div>
      <label htmlFor="stress-move" className="eyebrow">
        Market-wide move
      </label>
      <input id="stress-move" type="range" min={-50} max={50} value={move} disabled={!enabled} onChange={(e) => setMove(Number(e.target.value))} className="mt-2 w-full accent-[#8B5CF6]" />
      <div className="num mt-1 text-[13px]">
        Mark moves <b>{move > 0 ? '+' : ''}{move}%</b>
      </div>
      <ErrorNote error={error} what="The stress test" />
      {!enabled ? (
        <div className="mt-3 text-[12.5px] text-muted">Nothing to stress: no assessable position right now.</div>
      ) : result === undefined ? (
        <Skeleton className="mt-3 h-[80px] w-full" />
      ) : !result.ok ? (
        <div className="mt-3 text-[12.5px] text-danger">{result.reason}</div>
      ) : (
        <>
          <table className="mt-3 w-full border-collapse text-[13px]">
            <tbody>
              {result.perPosition.map((line) => (
                <tr key={line.marketId} className="border-t border-border">
                  <td className="py-[7px]">
                    {line.symbol} {line.side}
                  </td>
                  <td className={`num py-[7px] text-right ${line.survives ? 'text-safe' : 'text-danger'}`}>
                    {line.survives
                      ? `survives · ${line.bufferAfterPct === undefined ? '' : `buffer ${formatPct(line.bufferAfterPct)}`}`
                      : `liquidated · −${formatAusd(line.marginLostAusd)} margin`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-[12px] text-muted">
            {result.liquidatedCount === 0
              ? `Every position survives a ${move}% move.`
              : `${result.liquidatedCount} of ${result.perPosition.length} liquidated, ${formatAusd(result.totalMarginLostAusd)} AUSD of margin gone (a floor, before fees).`}
            {result.liquidatedCount > 0 && result.freeBalance.known && (
              <>
                {' '}
                Free balance ≥ {formatAusd(result.freeBalance.floorAusd, 0)} {cover === undefined ? 'is there' : `covers the ${formatAusd(result.shortfallAusd)} shortfall ${cover >= 10 ? Math.round(cover) : cover.toFixed(1)}× over`}. Isolated margin won&rsquo;t reach for it.
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
