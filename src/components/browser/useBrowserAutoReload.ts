import { useEffect, useRef } from 'react';
import { useStoreSelector } from '../../hooks/useStore';
import { reloadBrowser } from '../../lib/commands';
import { isEditTool } from '../../lib/diff';

const LOCAL_DEV_SERVER = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/;
const RELOAD_DEBOUNCE_MS = 600;

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
  const lastEditTsRef = useRef(0);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTranscriptEvent = useStoreSelector((current) => {
    const transcript = requestedChatId ? current.transcripts[requestedChatId] : undefined;
    return transcript?.[transcript.length - 1];
  });

  useEffect(() => {
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
    const last = lastTranscriptEvent;
    if (last?.kind !== 'tool_result') return;
    if (!isEditTool(last.toolName) || last.isError) return;
    if (last.ts <= lastEditTsRef.current) return;
    lastEditTsRef.current = last.ts;
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      reloadBrowser(browserKey);
    }, RELOAD_DEBOUNCE_MS);
  }, [activeUrl, browserKey, lastTranscriptEvent]);

  // Cancel any pending auto-reload when the browser session switches or the
  // component unmounts, so a stale timer doesn't reload the wrong session.
  useEffect(() => {
    return () => {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, [browserKey]);
}
