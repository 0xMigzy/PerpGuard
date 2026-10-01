'use client';

import { api } from './api.ts';
import { usePoll } from './usePoll.ts';

const HISTORY_POLL_MS = 5 * 60_000;

/** The full history curve, polled slowly: it changes once a day at most. */
export function useHistory() {
  return usePoll(() => api.history(), HISTORY_POLL_MS, 'history');
}

/** Where the index's history begins, once known. */
export function useHistoryStart(): number | undefined {
  return useHistory().data?.data.startsAtMs;
}
