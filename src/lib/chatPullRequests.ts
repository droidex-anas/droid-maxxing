import { getGitEnvironment } from './git';
import { detectPullRequest, getGithubAvailability } from './github';
import type { SessionSummary } from '../types/bridge';
import type { ChatPullRequest } from './chatMetadata';

export type ChatPrTarget = Pick<SessionSummary, 'appSessionId' | 'cwd'>;

const LOOKUP_TIMEOUT_MS = 10_000;

async function waitForLookup<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(new Error('PR discovery cancelled.'));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          reject(new Error('PR discovery lookup timed out.'));
        }, LOOKUP_TIMEOUT_MS);
      }),
      operation,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

const discoveryApi = { getGitEnvironment, detectPullRequest, getGithubAvailability };

// Owns in-flight Git/GitHub IPC across refreshes and effect cancellation.
// A deadline ends the wait, not the work: timed-out lookups stay counted until
// they settle so a later scan cannot pile onto a hung call. Other worktrees in
// the same scan still continue.
export class ChatPullRequestDiscovery {
  private inFlight = 0;

  constructor(private readonly api = discoveryApi) {}

  private async lookup<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('PR discovery cancelled.');
    const operation = run();
    this.inFlight += 1;
    void operation.finally(() => {
      this.inFlight -= 1;
    });
    return waitForLookup(operation, signal);
  }

  // Re-read membership after provider work so closed or moved chats cannot
  // acquire a link from an earlier snapshot. Failures preserve existing links.
  async discover(
    getTargets: () => readonly ChatPrTarget[],
    onDetected: (cwd: string, appSessionIds: string[], pr: ChatPullRequest) => void,
    isCancelled: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.inFlight > 0) return;
    const api = this.api;
    const targets = getTargets();
    const directories = new Set(targets.map((target) => target.cwd).filter(Boolean));
    if (directories.size === 0 || isCancelled()) return;
    const availability = await this.lookup(() => api.getGithubAvailability(), signal);
    if (isCancelled() || !availability.installed || !availability.authenticated) return;
    const detected = new Map<string, ReturnType<typeof api.detectPullRequest>>();
    for (const cwd of directories) {
      try {
        if (isCancelled()) return;
        const env = await this.lookup(() => api.getGitEnvironment(cwd), signal);
        if (isCancelled()) return;
        const branch = env.branch;
        if (!env.isGitHub || !branch) continue;
        const worktreePath = env.worktreePath;
        if (!worktreePath)
          throw new Error('Git environment is missing its canonical worktree path.');
        const key = JSON.stringify([worktreePath, branch]);
        let pending = detected.get(key);
        if (!pending) {
          pending = this.lookup(() => api.detectPullRequest(worktreePath, branch), signal);
          detected.set(key, pending);
        }
        const result = await pending;
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
      } catch (error) {
        if (isCancelled() || signal?.aborted) return;
        console.warn('Automatic chat PR discovery failed; retrying on the next refresh.', error);
      }
    }
  }
}
