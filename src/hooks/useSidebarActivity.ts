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

// A persisted digest is only trusted while the chat has not moved past it.
function freshDigest(
  digests: Partial<Record<string, ActivityDigest>>,
  session: SessionSummary,
): ActivityDigest | undefined {
  const digest = digests[session.appSessionId];
  return digest && digest.at >= session.updatedAt ? digest : undefined;
}
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
  now: number,
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

  const digests = useActivityDigests(preferences.view === 'activity');

  // Idle worktrees worth a git call: the newest chat per folder, if it is
  // idle, unsettled and recent, capped so the poll stays cheap. Only that chat
  // may own the "to ship" signal; a newer live or settled chat in the same
  // folder claims it for nobody, so folder-mates never light up in its place.
  const shipOwners = useMemo(() => {
    const owners = new Map<string, string>();
    if (preferences.view !== 'activity') return owners;
    const claimed = new Set<string>();
    const known: Partial<Record<string, SessionSummary>> = state.sessions;
    const sessions = state.sessionOrder
      .map((id) => known[id])
      .filter((session): session is SessionSummary => Boolean(session?.cwd))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.appSessionId.localeCompare(b.appSessionId));
    for (const session of sessions) {
      if (claimed.has(session.cwd)) continue;
      claimed.add(session.cwd);
      const settledAt = preferences.settled[session.appSessionId] ?? -1;
      if (sessionIsLive(session) || settledAt >= session.updatedAt) continue;
      if (now - session.updatedAt > SHIP_WINDOW_MS) continue;
      owners.set(session.cwd, session.appSessionId);
      if (owners.size >= SHIP_POLL_LIMIT) break;
    }
    return owners;
  }, [preferences.view, preferences.settled, state.sessionOrder, state.sessions, now]);
  const shipCwds = useMemo(() => [...shipOwners.keys()], [shipOwners]);
  const diffs = useActivityShipSignals(shipCwds, preferences.view === 'activity');

  const statusFor = useCallback(
    (session: SessionSummary): SessionActivityStatus => {
      const id = session.appSessionId;
      const digest = freshDigest(digests, session);
      const metadata: Partial<ChatMetadataMap> = state.chatMetadata;
      const links = metadata[id]?.pullRequests ?? [];
      const owned: Partial<Record<string, GitDiffStat>> = diffs;
      const diff = shipOwners.get(session.cwd) === id ? owned[session.cwd] : undefined;
      return sessionActivityStatus(session, {
        attention: sessionAttention(id, state.pendingPermissions, state.pendingQuestions),
        unread: sessionIsUnread(session, state.activeAppSessionId, state.sessionLastSeen[id]),
        settledAt: preferences.settled[id],
        awaitingReply: digest?.modelSpokeLast ?? false,
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
        digest: freshDigest(digests, session),
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
