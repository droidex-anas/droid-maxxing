import { useEffect, useMemo, useRef } from 'react';

const SAVE_DELAY_MS = 1000;
import {
  digestTranscript,
  loadActivityDigests,
  saveActivityDigests,
  type ActivityDigest,
} from '../lib/activityDigest';
import { useStoreSelector } from './useStore';

// Digests for every chat this profile has seen: live ones from transcripts in
// the store, backed by a persisted copy for chats not opened since launch. A
// persisted digest is trusted only while the session has not moved past it.
function persist(digests: Record<string, ActivityDigest> | null): void {
  if (!digests) return;
  try {
    saveActivityDigests(window.localStorage, digests);
  } catch {
    // Persistence is a convenience; the in-memory digest still drives the view.
  }
}

function same(x: ActivityDigest, y: ActivityDigest): boolean {
  return (
    x.at === y.at &&
    x.modelSpokeLast === y.modelSpokeLast &&
    x.snippet === y.snippet &&
    x.activity === y.activity
  );
}

// `enabled` gates the transcript walk so a hidden inbox costs nothing per
// store update; the persisted copy still serves whatever it last saw.
export function useActivityDigests(enabled: boolean): Record<string, ActivityDigest> {
  const stored = useRef<Record<string, ActivityDigest> | null>(null);
  stored.current ??= typeof window === 'undefined' ? {} : loadActivityDigests(window.localStorage);
  const live = useStoreSelector(
    (state) => {
      const digests: Record<string, ActivityDigest> = {};
      if (!enabled) return digests;
      for (const [id, events] of Object.entries(state.transcripts)) {
        const digest = digestTranscript(events);
        if (digest) digests[id] = digest;
      }
      return digests;
    },
    (a, b) => {
      const keys = Object.keys(a);
      return (
        keys.length === Object.keys(b).length && keys.every((id) => id in b && same(a[id], b[id]))
      );
    },
  );

  const merged = useMemo(() => ({ ...stored.current, ...live }), [live]);

  // Streaming text changes the digest on every token, so persist a beat later
  // rather than rewriting the cache each time.
  useEffect(() => {
    stored.current = merged;
    const timer = setTimeout(() => {
      persist(stored.current);
    }, SAVE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [merged]);

  // A collapse or quit inside the save delay must not drop the last change.
  useEffect(() => {
    const flush = () => {
      persist(stored.current);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  return merged;
}
