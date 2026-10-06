import {
  collateralBalanceAt,
  finalizedBlock,
  scanTreasuryMovements,
  type CollateralTotalsAtBlock,
  type TreasuryMovement,
  type TreasuryReconciliation,
  type TreasuryRpcOptions,
  type TreasuryScanStatus,
} from '@perpguard/shared';

/**
 * Keeps the protocol treasury's movements current, incrementally.
 *
 * At start-up and every `intervalMs` (15 minutes), it scans ONLY from the block
 * after its stored cursor to the latest FINALIZED block, stores what it found
 * and the new cursor together, and then reconciles: at the index's own latest
 * block, indexed deposits − withdrawals ± treasury in/out against the
 * contract's balance AT THAT BLOCK. Comparing at one block is the point: the
 * index trails the chain by ~145 blocks, and a live balance would be off by
 * whatever was deposited in that minute.
 *
 * NEVER TWO AT ONCE: an in-process flag, and the store's lock (a Postgres
 * advisory lock) in case a second backend ever runs. A run that fails is
 * logged, kept as the status, and retried at the next interval.
 *
 * The rebuild has differed from the contract by exactly 27.70 AUSD since it was
 * first measured (6 Oct 2026), unexplained by any event read. A difference
 * outside 27.70 ± 1 is logged as a warning and shown on the page.
 */
export interface TreasuryStore {
  load(): Promise<{ readonly throughBlock: number | undefined; readonly movements: readonly TreasuryMovement[] }>;
  /** New movements and the cursor, together or not at all. */
  save(movements: readonly TreasuryMovement[], throughBlock: number): Promise<void>;
  /** A cross-process lock; undefined when another holder has it. */
  tryLock(): Promise<(() => Promise<void>) | undefined>;
}

export const TREASURY_SCAN_INTERVAL_MS = 15 * 60_000;
/** The difference measured since 6 Oct 2026 and not yet explained: 27.700465 AUSD. */
export const EXPECTED_UNEXPLAINED_GAP_CNS = 27_700_465n;
export const GAP_TOLERANCE_CNS = 1_000_000n;

export interface TreasuryScannerOptions {
  readonly store: TreasuryStore;
  readonly rpc: TreasuryRpcOptions;
  readonly collateralAtIndexHead: () => Promise<CollateralTotalsAtBlock>;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
  /** Injectable for tests. */
  readonly chain?: {
    readonly finalizedBlock: typeof finalizedBlock;
    readonly scan: typeof scanTreasuryMovements;
    readonly balanceAt: typeof collateralBalanceAt;
  };
}

const ausd = (cns: bigint, decimals: number) => Number(cns) / 10 ** decimals;

/** A short, renderable reason; never a URL (the RPC URL carries a token). */
export function describeScanError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/timeout|aborted/i.test(text)) return 'the RPC timed out';
  if (/HTTP \d{3}/.test(text)) return `the RPC answered ${text.match(/HTTP \d{3}/)![0]}`;
  if (/historical state|not found/i.test(text)) return 'the RPC no longer holds that block’s state';
  if (/fetch failed|ECONN|ENOTFOUND/i.test(text)) return 'could not reach the RPC';
  if (/index has no processed block/.test(text)) return 'the index has no processed block yet';
  return 'the scan failed';
}

export class TreasuryScanner {
  readonly #o: TreasuryScannerOptions;
  readonly #now: () => number;
  readonly #chain: NonNullable<TreasuryScannerOptions['chain']>;
  #running = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #movements: readonly TreasuryMovement[] = [];
  #throughBlock: number | undefined;
  #scannedAtMs: number | undefined;
  #lastError: { readonly message: string; readonly atMs: number } | undefined;
  #reconciliation: TreasuryReconciliation | undefined;
  #loaded = false;

  constructor(options: TreasuryScannerOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#chain = options.chain ?? { finalizedBlock, scan: scanTreasuryMovements, balanceAt: collateralBalanceAt };
  }

  /** Run now, then every interval. */
  start(): void {
    void this.runOnce();
    this.#timer = setInterval(() => void this.runOnce(), this.#o.intervalMs ?? TREASURY_SCAN_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /** One incremental scan and a reconciliation. 'skipped' when a run already holds the lock. */
  async runOnce(): Promise<'ran' | 'skipped' | 'failed'> {
    if (this.#running) return 'skipped';
    this.#running = true;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.#o.store.tryLock();
      if (release === undefined) return 'skipped';
      if (!this.#loaded) {
        const stored = await this.#o.store.load();
        this.#movements = stored.movements;
        this.#throughBlock = stored.throughBlock;
        this.#loaded = true;
      }
      if (this.#throughBlock === undefined) throw new Error('the treasury store has no cursor to scan from');
      const to = await this.#chain.finalizedBlock(this.#o.rpc);
      if (to > this.#throughBlock) {
        const found = await this.#chain.scan(this.#throughBlock + 1, to, this.#o.rpc);
        await this.#o.store.save(found, to);
        this.#movements = [...this.#movements, ...found];
        if (found.length > 0) this.#o.log?.(`treasury scan: ${found.length} new movement(s) through block ${to}`);
        this.#throughBlock = to;
      }
      this.#scannedAtMs = this.#now();
      await this.#reconcile();
      this.#lastError = undefined;
      return 'ran';
    } catch (error) {
      this.#lastError = { message: describeScanError(error), atMs: this.#now() };
      this.#o.warn?.(`treasury scan failed: ${this.#lastError.message}; retrying in ${Math.round((this.#o.intervalMs ?? TREASURY_SCAN_INTERVAL_MS) / 60_000)} min`);
      return 'failed';
    } finally {
      await release?.().catch(() => undefined);
      this.#running = false;
    }
  }

  async #reconcile(): Promise<void> {
    const totals = await this.#o.collateralAtIndexHead();
    const B = totals.block;
    // The scan must cover the block compared at, or a treasury movement in between would read as a gap.
    if (this.#throughBlock === undefined || B > this.#throughBlock) return;
    const contract = await this.#chain.balanceAt(totals.collateralToken, B, this.#o.rpc);
    let treasury = 0n;
    for (const m of this.#movements) if (m.block <= B) treasury += m.direction === 'in' ? m.amountCNS : -m.amountCNS;
    const rebuilt = totals.depositedCNS - totals.withdrawnCNS + treasury;
    const gap = contract - rebuilt;
    const off = gap - EXPECTED_UNEXPLAINED_GAP_CNS;
    const withinExpected = (off < 0n ? -off : off) <= GAP_TOLERANCE_CNS;
    const d = totals.collateralDecimals;
    this.#reconciliation = {
      atBlock: B,
      checkedAtMs: this.#now(),
      rebuiltAusd: ausd(rebuilt, d),
      contractAusd: ausd(contract, d),
      gapAusd: ausd(gap, d),
      expectedGapAusd: ausd(EXPECTED_UNEXPLAINED_GAP_CNS, d),
      toleranceAusd: ausd(GAP_TOLERANCE_CNS, d),
      withinExpected,
    };
    if (!withinExpected) {
      this.#o.warn?.(
        `exchange balance: rebuilt ${ausd(rebuilt, d)} vs contract ${ausd(contract, d)} at block ${B}: ${ausd(gap, d)} AUSD apart, outside the known ${ausd(EXPECTED_UNEXPLAINED_GAP_CNS, d)} ± ${ausd(GAP_TOLERANCE_CNS, d)}`,
      );
    }
  }

  movements(): readonly TreasuryMovement[] {
    return this.#movements;
  }

  status(): TreasuryScanStatus {
    return {
      throughBlock: this.#throughBlock,
      scannedAtMs: this.#scannedAtMs,
      intervalMs: this.#o.intervalMs ?? TREASURY_SCAN_INTERVAL_MS,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError.message, lastErrorAtMs: this.#lastError.atMs }),
      ...(this.#reconciliation === undefined ? {} : { reconciliation: this.#reconciliation }),
    };
  }
}
