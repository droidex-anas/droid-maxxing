import { useEffect } from 'react';

import { setHistoryIndexingIdle } from '../lib/commands';
import { systemIdleTime } from '../lib/desktop';

const INDEXING_IDLE_SECONDS = 60;
const IDLE_SAMPLE_INTERVAL_MS = 30_000;

export function shouldRunHistoryBackfill(systemIdleSeconds: number | null): boolean {
  return systemIdleSeconds !== null && systemIdleSeconds >= INDEXING_IDLE_SECONDS;
}

export function useHistoryIndexingIdle(): void {
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sample = async (): Promise<void> => {
      try {
        const idleSeconds = await systemIdleTime();
        if (!disposed) {
          // Send every sample, not only transitions: the sidecar also pauses
          // backfill for live transcript work between desktop samples.
          setHistoryIndexingIdle(shouldRunHistoryBackfill(idleSeconds));
        }
      } catch {
        if (!disposed) setHistoryIndexingIdle(false);
      } finally {
        if (!disposed) timer = setTimeout(() => void sample(), IDLE_SAMPLE_INTERVAL_MS);
      }
    };
    void sample();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      setHistoryIndexingIdle(false);
    };
  }, []);
}
