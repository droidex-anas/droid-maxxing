import { useEffect, useMemo, useRef } from 'react';
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
function same(x: ActivityDigest, y: ActivityDigest): boolean {
  return (
    x.at === y.at &&
    x.modelSpokeLast === y.modelSpokeLast &&
    x.snippet === y.snippet &&
    x.activity === y.activity
  );
}

export function useActivityDigests(): Record<string, ActivityDigest> {
  const stored = useRef<Record<string, ActivityDigest>>(
    typeof window === 'undefined' ? {} : loadActivityDigests(window.localStorage),
  );
  const live = useStoreSelector(
    (state) => {
      const digests: Record<string, ActivityDigest> = {};
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

  useEffect(() => {
    stored.current = merged;
    try {
      saveActivityDigests(window.localStorage, merged);
    } catch {
      // Persistence is a convenience; the in-memory digest still drives the view.
    }
  }, [merged]);

  return merged;
}
