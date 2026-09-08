import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppState } from './useStore';
import type { SessionSummary } from '../types/bridge';
import type { GitDiffStat } from '../types/vcs';
import type { ChatMetadataMap } from '../lib/chatMetadata';
import { sessionAttention } from '../lib/sessionAttention';
import { sessionIsLive, sessionIsUnread } from '../lib/sessions';
import { prKind } from '../lib/github';
import { toast } from '../lib/toast';
import { activityReason } from '../lib/activityReason';
import {
  canSettleSession,
  pruneSettledSessions,
  DEFAULT_SIDEBAR_PREFERENCES,
  inActivityScope,
  loadSidebarActivity,
  saveSidebarActivity,
  sessionActivityStatus,
  type SessionActivityStatus,
  type SidebarActivityPreferences,
} from '../lib/sidebarActivity';
import { useActivityDigests } from './useActivityDigests';
import type { ActivityDigest } from '../lib/activityDigest';
import { useActivityShipSignals } from './useActivityShipSignals';

const SHIP_POLL_LIMIT = 12;
const SHIP_WINDOW_MS = 14 * 86_400_000;

// Sidebar preferences stay local to this profile; runtime status comes from the store.
export function useSidebarActivity(
  state: Pick<
    AppState,
    | 'pendingPermissions'
    | 'pendingQuestions'
    | 'activeAppSessionId'
    | 'sessionLastSeen'
    | 'sessions'
    | 'sessionOrder'
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

  const digests = useActivityDigests();

  // Idle worktrees worth a git call: the newest unsettled chat per folder,
  // touched recently, capped so the poll stays cheap. Only that chat may own
  // the "to ship" signal, so folder-mates never all light up together.
  const shipOwners = useMemo(() => {
    if (preferences.view !== 'activity') return new Map<string, string>();
    const now = Date.now();
    const owners = new Map<string, string>();
    const sessions: Partial<Record<string, SessionSummary>> = state.sessions;
    for (const id of state.sessionOrder) {
      const session = sessions[id];
      if (!session?.cwd || owners.has(session.cwd) || sessionIsLive(session)) continue;
      if (now - session.updatedAt > SHIP_WINDOW_MS) continue;
      if ((preferences.settled[id] ?? -1) >= session.updatedAt) continue;
      owners.set(session.cwd, id);
      if (owners.size >= SHIP_POLL_LIMIT) break;
    }
    return owners;
  }, [preferences.view, preferences.settled, state.sessionOrder, state.sessions]);
  const shipCwds = useMemo(() => [...shipOwners.keys()], [shipOwners]);
  const diffs = useActivityShipSignals(shipCwds, preferences.view === 'activity');

  const statusFor = useCallback(
    (session: SessionSummary): SessionActivityStatus => {
      const id = session.appSessionId;
      const known: Partial<Record<string, ActivityDigest>> = digests;
      const digest = known[id];
      const metadata: Partial<ChatMetadataMap> = state.chatMetadata;
      const links = metadata[id]?.pullRequests ?? [];
      const owned: Partial<Record<string, GitDiffStat>> = diffs;
      const diff = shipOwners.get(session.cwd) === id ? owned[session.cwd] : undefined;
      return sessionActivityStatus(session, {
        attention: sessionAttention(id, state.pendingPermissions, state.pendingQuestions),
        unread: sessionIsUnread(session, state.activeAppSessionId, state.sessionLastSeen[id]),
        settledAt: preferences.settled[id],
        awaitingReply:
          digest !== undefined && digest.at >= session.updatedAt && digest.modelSpokeLast,
        uncommitted: (diff?.files ?? 0) > 0,
        prDone:
          links.length > 0 && links.every((pr) => prKind(pr) !== 'open' && prKind(pr) !== 'draft'),
      });
    },
    [
      digests,
      diffs,
      shipOwners,
      state.chatMetadata,
      state.pendingPermissions,
      state.pendingQuestions,
      state.activeAppSessionId,
      state.sessionLastSeen,
      preferences.settled,
    ],
  );

  const reasonFor = useCallback(
    (session: SessionSummary, status: SessionActivityStatus) =>
      activityReason(status, {
        session,
        permission: state.pendingPermissions[session.appSessionId],
        question: state.pendingQuestions[session.appSessionId],
        digest: digests[session.appSessionId],
        diff: diffs[session.cwd],
      }),
    [digests, diffs, state.pendingPermissions, state.pendingQuestions],
  );

  const inScope = useCallback(
    (session: SessionSummary, now: number) => inActivityScope(statusFor(session), session, now),
    [statusFor],
  );

  return {
    preferences,
    update,
    view: preferences.view,
    statusFor,
    reasonFor,
    inScope,
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
