import { getGitEnvironment } from './git';
import { detectPullRequest, getGithubAvailability } from './github';
import type { SessionSummary } from '../types/bridge';
import type { ChatPullRequest } from './chatMetadata';

export type ChatPrTarget = Pick<SessionSummary, 'appSessionId' | 'cwd'>;

const discoveryApi = { getGitEnvironment, detectPullRequest, getGithubAvailability };

// One sequential lookup per worktree, regardless of how many chats share it.
// Re-read membership after provider work so closed or moved chats cannot acquire
// a link from an earlier snapshot. A failed lookup preserves previously saved links.
export async function discoverChatPullRequests(
  getTargets: () => readonly ChatPrTarget[],
  onDetected: (cwd: string, appSessionIds: string[], pr: ChatPullRequest) => void,
  isCancelled: () => boolean,
  api = discoveryApi,
): Promise<void> {
  const targets = getTargets();
  const directories = new Set(targets.map((target) => target.cwd).filter(Boolean));
  if (directories.size === 0 || isCancelled()) return;
  const availability = await api.getGithubAvailability();
  if (isCancelled() || !availability.installed || !availability.authenticated) return;
  for (const cwd of directories) {
    if (isCancelled()) return;
    const env = await api.getGitEnvironment(cwd);
    if (isCancelled()) return;
    if (!env.isGitHub || !env.branch) continue;
    const result = await api.detectPullRequest(cwd, env.branch);
    if (isCancelled()) return;
    if (!result.ok) {
      console.warn('Automatic chat PR discovery failed; retrying on the next refresh.');
      continue;
    }
    if (!result.pr) continue;
    const originalIds = new Set(
      targets.filter((target) => target.cwd === cwd).map((target) => target.appSessionId),
    );
    const ids = getTargets()
      .filter((target) => target.cwd === cwd && originalIds.has(target.appSessionId))
      .map((target) => target.appSessionId);
    if (ids.length > 0) onDetected(cwd, ids, result.pr);
  }
}
