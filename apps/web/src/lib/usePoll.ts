'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollState<T> {
  /** The last GOOD answer. Kept through errors, so a blip never blanks a page. */
  readonly data: T | undefined;
  /** The latest failure, cleared by the next success. */
  readonly error: unknown;
  /** True until the first answer, good or bad. Skeleton time. */
  readonly loading: boolean;
  readonly updatedAtMs: number | undefined;
  readonly refresh: () => void;
}

/**
 * Fetch now and every `intervalMs`, pausing while the tab is hidden.
 *
 * `key` restarts the poll (and resets to loading) when it changes — a
 * timeframe switch, for instance — so a page never shows one window's numbers
 * under another's label while the new request is in flight.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, key: string): PollState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [updatedAtMs, setUpdatedAtMs] = useState<number | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setData(undefined);
    setError(undefined);

    const run = async () => {
      if (!alive) return;
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(run, intervalMs);
        return;
      }
      try {
        const next = await loadRef.current();
        if (!alive) return;
        setData(next);
        setError(undefined);
        setUpdatedAtMs(Date.now());
      } catch (failure) {
        if (!alive) return;
        setError(failure);
      } finally {
        if (alive) {
          setLoading(false);
          timer = setTimeout(run, intervalMs);
        }
      }
    };

    void run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (timer !== undefined) clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, key, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, updatedAtMs, refresh };
}
