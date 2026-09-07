import { useCallback, useEffect, useState } from 'react';
import type { AppState } from './useStore';
import type { SessionSummary } from '../types/bridge';
import { sessionAttention } from '../lib/sessionAttention';
import { sessionIsUnread } from '../lib/sessions';
import { toast } from '../lib/toast';
import {
  canSettleSession,
  pruneSettledSessions,
  DEFAULT_SIDEBAR_PREFERENCES,
  loadSidebarActivity,
  saveSidebarActivity,
  sessionActivityStatus,
  type SidebarActivityPreferences,
} from '../lib/sidebarActivity';

// Sidebar preferences stay local to this profile; runtime status comes from the store.
export function useSidebarActivity(
  state: Pick<
    AppState,
    | 'pendingPermissions'
    | 'pendingQuestions'
    | 'activeAppSessionId'
    | 'sessionLastSeen'
    | 'sessions'
    | 'chatMetadata'
  >,
) {
  const [preferences, setPreferences] = useState<SidebarActivityPreferences>(() => {
    if (typeof window === 'undefined') return { ...DEFAULT_SIDEBAR_PREFERENCES, settled: {} };
    try {
      return loadSidebarActivity(window.localStorage);
    } catch (error) {
      console.error('Unable to load sidebar activity preferences', error);
      return { ...DEFAULT_SIDEBAR_PREFERENCES, settled: {} };
    }
  });

  useEffect(() => {
    const settled = pruneSettledSessions(preferences.settled, state.sessions, state.chatMetadata);
    if (settled === preferences.settled) return;
    const next = { ...preferences, settled };
    // Pruning is authoritative in memory even when persistence is unavailable.
    // This makes the reactive effect converge instead of retrying on every token.
    setPreferences(next);
    try {
      saveSidebarActivity(window.localStorage, next);
    } catch {
      toast.error('Could not save sidebar preferences. Check available disk space and try again.');
    }
  }, [preferences, state.sessions, state.chatMetadata]);

  function update(next: SidebarActivityPreferences) {
    try {
      saveSidebarActivity(window.localStorage, next);
      setPreferences(next);
    } catch {
      toast.error('Could not save sidebar preferences. Check available disk space and try again.');
    }
  }

  const statusFor = useCallback(
    (session: SessionSummary) => {
      return sessionActivityStatus(session, {
        attention: sessionAttention(
          session.appSessionId,
          state.pendingPermissions,
          state.pendingQuestions,
        ),
        unread: sessionIsUnread(
          session,
          state.activeAppSessionId,
          state.sessionLastSeen[session.appSessionId],
        ),
        settledAt: preferences.settled[session.appSessionId],
      });
    },
    [
      state.pendingPermissions,
      state.pendingQuestions,
      state.activeAppSessionId,
      state.sessionLastSeen,
      preferences.settled,
    ],
  );

  return {
    preferences,
    update,
    view: preferences.view,
    statusFor,
    settle: (session: SessionSummary) => {
      const status = statusFor(session);
      if (!canSettleSession(status)) return;
      update({
        ...preferences,
        settled: { ...preferences.settled, [session.appSessionId]: session.updatedAt },
      });
    },
    reopen: (session: SessionSummary) => {
      const settled = Object.fromEntries(
        Object.entries(preferences.settled).filter(([id]) => id !== session.appSessionId),
      );
      update({ ...preferences, settled });
    },
  };
}
