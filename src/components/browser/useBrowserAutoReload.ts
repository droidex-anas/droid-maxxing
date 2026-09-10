import { useEffect, useMemo, useRef } from 'react';
import { useStoreSelector } from '../../hooks/useStore';
import { reloadBrowser } from '../../lib/commands';
import type { TranscriptEvent } from '../../types/bridge';
import { createBrowserEditTracker } from './browserEditTracker';

const LOCAL_DEV_SERVER =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;
const RELOAD_DEBOUNCE_MS = 600;
const EMPTY_TRANSCRIPT: readonly TranscriptEvent[] = [];

// When the agent edits files and the browser shows a local dev server URL,
// reload the pane after a short debounce so the new code is visible
// immediately. The timeout id lives in a ref so that subsequent transcript
// updates (non-edit events) don't clear a pending reload that was already
// scheduled.
export function useBrowserAutoReload(
  browserKey: string | undefined,
  activeUrl: string,
  requestedChatId: string | undefined,
): void {
  const completesEdit = useMemo(createBrowserEditTracker, [browserKey, requestedChatId]);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcript = useStoreSelector(
    (current) => {
      const events = requestedChatId ? current.transcripts[requestedChatId] : undefined;
      return {
        events: events ?? EMPTY_TRANSCRIPT,
        mutation: requestedChatId ? current.transcriptMutations[requestedChatId] : undefined,
      };
    },
    (left, right) => left.events === right.events && left.mutation === right.mutation,
  );

  useEffect(() => {
    const completedEdit = completesEdit(transcript.events, transcript.mutation);
    if (!browserKey) return;
    // Eligibility is checked first so navigating away from a local dev server
    // cancels any reload that was scheduled while the URL was still eligible;
    // otherwise a stale edit reload could fire against an unrelated page.
    if (!LOCAL_DEV_SERVER.test(activeUrl)) {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
      return;
    }
    if (!completedEdit) return;
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      reloadBrowser(browserKey);
    }, RELOAD_DEBOUNCE_MS);
  }, [activeUrl, browserKey, completesEdit, transcript]);

  // Cancel any pending auto-reload when the browser session switches or the
  // component unmounts, so a stale timer doesn't reload the wrong session.
  useEffect(() => {
    return () => {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, [activeUrl, browserKey, requestedChatId]);
}
