import { providerSessionsDir } from './droidexPaths.js';
import type { SessionFileChange } from './sessionFileCache.js';
import type { SessionListFilterOptions, SessionListPage } from './sessionListFilter.js';
import type { SessionFileWatcher, SessionFileWatcherOptions } from './sessionFileWatcher.js';
import { errMsg } from './sessionHelpers.js';

interface SessionFileServingHistory {
  reconcileSessionFiles(): Promise<number>;
  reconcileSessionFilePaths(changes: SessionFileChange[]): Promise<number>;
}

interface SessionFileServingDependencies {
  history: SessionFileServingHistory;
  startWatcher: (options: SessionFileWatcherOptions) => SessionFileWatcher | null;
  isLiveSession: (providerSessionId: string) => boolean;
  isShutdownStarted: () => boolean;
  retryPendingLaunchSettings: (providerSessionIds?: string[]) => void;
  listSummaries: (options?: SessionListFilterOptions) => SessionListPage;
  emitList: (page: SessionListPage) => void;
}

const ignoreError = (): undefined => undefined;

export class SessionFileServing {
  private bootstrapDone = false;
  private bootReconcile: Promise<void> | null = null;
  private bootReconciled = false;
  private bootChanges: Map<string, SessionFileChange> | null = new Map();
  private reconcileTail: Promise<void> = Promise.resolve();
  // One watcher per scanned session-file root (Droid's own tree, and the
  // transcripts DROIDEX writes for the other providers).
  private watchers: SessionFileWatcher[] = [];
  private lastListOptions?: SessionListFilterOptions;

  constructor(private readonly dependencies: SessionFileServingDependencies) {}

  start(): void {
    this.bootstrap();
  }

  async list(options: SessionListFilterOptions): Promise<void> {
    this.lastListOptions = options;
    await this.whenBootReconciled();
    if (!this.dependencies.isShutdownStarted() && this.lastListOptions === options) {
      this.emit(options);
    }
  }

  // History restore uses the worker-published path mirror. Loading before the
  // first boot reconcile finishes reports "not found" for sessions that are
  // already on disk, including every origin/main upgrade whose derived cache
  // does not exist yet.
  async whenBootReconciled(): Promise<void> {
    this.bootstrap();
    const boot = this.bootReconcile;
    if (boot) await boot;
  }

  finalizeReplacedProvider(providerSessionId: string): void {
    if (this.dependencies.isShutdownStarted() || this.watchers.length === 0) return;
    const path = this.consumeLiveSessionFile(providerSessionId);
    const changes = path ? [{ providerSessionId, path }] : null;
    const reconcile = this.queueReconcile(() => this.reconcileExternal(changes));
    void reconcile.catch((error: unknown) => {
      this.markCacheStale();
      console.error(`Finalized session file reconcile failed: ${errMsg(error)}`);
    });
  }

  async finalizeClosedProvider(providerSessionId: string): Promise<void> {
    if (this.dependencies.isShutdownStarted()) return;
    const path = this.consumeLiveSessionFile(providerSessionId);
    const changes = path ? [{ providerSessionId, path }] : null;
    await this.queueReconcile(() => this.reconcileExternal(changes));
  }

  async close(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    await this.reconcileTail;
  }

  watcherCount(): number {
    return this.watchers.length;
  }

  // The session whose file was just finalized lives under exactly one root.
  private consumeLiveSessionFile(providerSessionId: string): string | undefined {
    for (const watcher of this.watchers) {
      const path = watcher.consumeLiveSessionFile(providerSessionId);
      if (path) return path;
    }
    return undefined;
  }

  private emit(options?: SessionListFilterOptions): void {
    this.dependencies.emitList(this.dependencies.listSummaries(options));
  }

  private bootstrap(): void {
    if (!this.bootstrapDone) {
      this.bootstrapDone = true;
      const watch = (root?: string): void => {
        const watcher = this.dependencies.startWatcher({
          ...(root !== undefined ? { root } : {}),
          isLiveSession: this.dependencies.isLiveSession,
          onExternalChange: (changes) => {
            if (this.dependencies.isShutdownStarted()) return;
            if (!this.bootReconciled) {
              this.rememberBootChanges(changes);
              return;
            }
            const reconcile = this.queueReconcile(() => this.reconcileExternal(changes));
            void reconcile.catch((error: unknown) => {
              this.markCacheStale();
              console.error(`Session file cache reconcile failed: ${errMsg(error)}`);
            });
          },
        });
        if (watcher) this.watchers.push(watcher);
      };
      watch();
      watch(providerSessionsDir());
    }
    if (this.bootReconciled || this.bootReconcile) return;

    const boot = this.queueReconcile(async () => {
      if (this.dependencies.isShutdownStarted()) return;
      await this.dependencies.history.reconcileSessionFiles();
      while (!this.dependencies.isShutdownStarted()) {
        const changes = this.takeBootChanges();
        if (changes === undefined) break;
        if (changes) await this.dependencies.history.reconcileSessionFilePaths(changes);
        else await this.dependencies.history.reconcileSessionFiles();
      }
      if (this.dependencies.isShutdownStarted()) return;
      this.dependencies.retryPendingLaunchSettings();
      this.bootReconciled = true;
    }).finally(() => {
      if (this.bootReconcile === boot) this.bootReconcile = null;
    });
    this.bootReconcile = boot;
  }

  private rememberBootChanges(changes: SessionFileChange[] | null): void {
    if (!changes) {
      this.bootChanges = null;
      return;
    }
    if (!this.bootChanges) return;
    for (const change of changes) this.bootChanges.set(change.providerSessionId, change);
  }

  private takeBootChanges(): SessionFileChange[] | null | undefined {
    const changes = this.bootChanges;
    this.bootChanges = new Map();
    if (!changes) return null;
    return changes.size > 0 ? [...changes.values()] : undefined;
  }

  private markCacheStale(): void {
    if (this.dependencies.isShutdownStarted()) return;
    this.bootReconciled = false;
    this.bootChanges = new Map();
  }

  private queueReconcile(operation: () => Promise<void>): Promise<void> {
    const result = this.reconcileTail.then(operation, operation);
    // Settled tail: callers still observe `result`; close() must not inherit an
    // unhandled rejection from a reconcile that raced a removed session file.
    this.reconcileTail = result.catch(ignoreError);
    return result;
  }

  private async reconcileExternal(changes: SessionFileChange[] | null): Promise<void> {
    if (this.dependencies.isShutdownStarted()) return;
    if (changes) await this.dependencies.history.reconcileSessionFilePaths(changes);
    else await this.dependencies.history.reconcileSessionFiles();
    if (this.dependencies.isShutdownStarted()) return;
    this.dependencies.retryPendingLaunchSettings(
      changes?.map(({ providerSessionId }) => providerSessionId),
    );
    this.emit(this.lastListOptions);
  }
}
