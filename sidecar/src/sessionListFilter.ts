import type { SessionSummary } from './protocol.js';

// Opening a folder a Droid CLI has been used in should feel familiar without
// dragging in years of unrelated conversations: show the handful of most recent
// pre-existing sessions, and from then on the sessions DROIDEX itself ran. Five
// matches the sidebar's page size, so a freshly opened workspace fills exactly
// one page and the rest stays one click away.
export const FAMILIAR_PREEXISTING_SESSIONS_PER_WORKSPACE = 5;

export interface SessionListFilterOptions {
  workspaceCwds?: string[];
  includePlainChats?: boolean;
  // Workspaces whose pre-existing bound the user lifted via "Show earlier".
  revealEarlierCwds?: string[];
}

export interface SessionListPage {
  sessions: SessionSummary[];
  // Pre-existing sessions withheld per requested cwd. A missing key means the
  // folder has nothing more to reveal.
  earlierSessionsByCwd: Record<string, number>;
}

// `isAppOwned` answers "did DROIDEX run this session": true for anything with a
// persisted app-session row or a live runtime, false for a session file some
// other Droid client wrote.
export function filterSessionListSummaries(
  summaries: SessionSummary[],
  options: SessionListFilterOptions,
  isAppOwned: (summary: SessionSummary) => boolean,
): SessionListPage {
  if (!options.workspaceCwds && !options.includePlainChats) {
    return { sessions: summaries, earlierSessionsByCwd: {} };
  }

  const workspaceCwds = [...new Set((options.workspaceCwds ?? []).filter(Boolean))];
  if (workspaceCwds.length === 0 && !options.includePlainChats) {
    return { sessions: [], earlierSessionsByCwd: {} };
  }

  const { byCwd, plainChats } = groupByWorkspace(summaries, new Set(workspaceCwds));
  // Folder-less chats only exist because DROIDEX created them, so the
  // pre-existing bound has nothing to say about them.
  const listed = options.includePlainChats ? plainChats : [];
  const revealed = new Set(options.revealEarlierCwds ?? []);
  const earlierSessionsByCwd: Record<string, number> = {};

  for (const cwd of workspaceCwds) {
    const group = (byCwd.get(cwd) ?? []).sort(byNewestFirst);
    if (revealed.has(cwd)) {
      listed.push(...group);
      continue;
    }
    const { shown, withheld } = boundPreexisting(group, isAppOwned);
    listed.push(...shown);
    if (withheld > 0) earlierSessionsByCwd[cwd] = withheld;
  }

  return { sessions: listed.sort(byNewestFirst), earlierSessionsByCwd };
}

function groupByWorkspace(
  summaries: SessionSummary[],
  requested: Set<string>,
): { byCwd: Map<string, SessionSummary[]>; plainChats: SessionSummary[] } {
  const byCwd = new Map<string, SessionSummary[]>();
  const plainChats: SessionSummary[] = [];
  for (const summary of summaries) {
    if (!summary.cwd) {
      plainChats.push(summary);
      continue;
    }
    if (!requested.has(summary.cwd)) continue;
    const group = byCwd.get(summary.cwd) ?? [];
    group.push(summary);
    byCwd.set(summary.cwd, group);
  }
  return { byCwd, plainChats };
}

// Keeps every app-owned session plus the newest few pre-existing ones. The
// group must already be newest-first.
function boundPreexisting(
  group: SessionSummary[],
  isAppOwned: (summary: SessionSummary) => boolean,
): { shown: SessionSummary[]; withheld: number } {
  const shown: SessionSummary[] = [];
  let preexisting = 0;
  let withheld = 0;
  for (const summary of group) {
    if (isAppOwned(summary)) {
      shown.push(summary);
    } else if (preexisting < FAMILIAR_PREEXISTING_SESSIONS_PER_WORKSPACE) {
      preexisting += 1;
      shown.push(summary);
    } else {
      withheld += 1;
    }
  }
  return { shown, withheld };
}

function byNewestFirst(left: SessionSummary, right: SessionSummary): number {
  return right.updatedAt - left.updatedAt;
}
