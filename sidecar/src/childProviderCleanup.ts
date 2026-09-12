import type { ParentChildSessions } from './ChildSessionState.js';
import type { ChildSessionsDependencies } from './ChildSessionsTypes.js';
import type { FactorySession } from './DroidRuntime.js';
import { RuntimeRetirementTimer } from './runtimeRetirementTimer.js';
import { errMsg } from './sessionHelpers.js';

const RETRY_MS = 5_000;

interface PendingClose {
  parent: ParentChildSessions;
  session: FactorySession;
  pid: number | undefined;
  ready: Promise<void>;
  closing?: Promise<boolean>;
  retryAt?: number;
}

// Retired runtimes no longer accept child work, but still own their provider
// until descendants are adopted and the provider has actually closed.
export class ChildProviderCleanup {
  private readonly pending = new Map<FactorySession, PendingClose>();
  private stopped = false;
  private readonly timer = new RuntimeRetirementTimer(() => {
    void this.retry().catch((error: unknown) => {
      console.warn(`Child provider cleanup retry failed: ${errMsg(error)}`);
    });
  });

  constructor(
    private readonly d: Pick<ChildSessionsDependencies, 'runtime' | 'agentProcesses' | 'now'>,
    private readonly onCapacityAvailable: (parentAppSessionId: string) => void,
  ) {}

  count(parentAppSessionId: string): number {
    let count = 0;
    for (const entry of this.pending.values())
      if (entry.parent.parentAppSessionId === parentAppSessionId) count += 1;
    return count;
  }

  async release(
    parent: ParentChildSessions,
    session: FactorySession,
    ready: Promise<void>,
  ): Promise<void> {
    let entry = this.pending.get(session);
    if (!entry) {
      entry = { parent, session, pid: this.d.runtime.processIdOf(session), ready };
      this.pending.set(session, entry);
    }
    await this.attempt(entry);
  }

  async closeParent(parent: ParentChildSessions): Promise<void> {
    const entries = [...this.pending.values()].filter((entry) => entry.parent === parent);
    const closed = await Promise.all(entries.map((entry) => this.attempt(entry)));
    if (closed.some((success) => !success))
      throw new Error('Could not close every child provider; cleanup will retry.');
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.timer.cancel();
    const closed = await Promise.all(
      [...this.pending.values()].map((entry) => this.attempt(entry)),
    );
    if (closed.some((success) => !success))
      throw new Error('Could not close every child provider during shutdown.');
  }

  private attempt(entry: PendingClose): Promise<boolean> {
    if (entry.closing) return entry.closing;
    entry.closing = entry.ready
      .then(() => this.closeProvider(entry))
      .finally(() => {
        entry.closing = undefined;
        this.armRetry();
      });
    return entry.closing;
  }

  private async closeProvider(entry: PendingClose): Promise<boolean> {
    try {
      if (entry.pid !== undefined && !entry.parent.closing) {
        const adopted = await this.d.agentProcesses.adoptDescendantsAsRoots(
          entry.parent.parentAppSessionId,
          entry.pid,
          () => !entry.parent.closing && !entry.parent.lease.closeMode,
        );
        // Parent closure starts only after its process-kill pass finishes.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Parent closure can begin during the adoption await.
        if (!adopted && !entry.parent.closing)
          throw new Error('Could not preserve child processes before retiring their provider.');
      }
      await entry.session.close();
      if (entry.pid !== undefined)
        this.d.agentProcesses.untrack(entry.pid, entry.parent.parentAppSessionId);
      this.pending.delete(entry.session);
      return true;
    } catch (error) {
      if (entry.retryAt === undefined)
        console.warn(`Child provider cleanup deferred: ${errMsg(error)}`);
      entry.retryAt = this.d.now() + RETRY_MS;
      return false;
    }
  }

  private async retry(): Promise<void> {
    const entries = [...this.pending.values()].filter(
      (entry) => entry.retryAt !== undefined && entry.retryAt <= this.d.now(),
    );
    const closed = await Promise.all(entries.map((entry) => this.attempt(entry)));
    this.armRetry();
    entries.forEach((entry, index) => {
      if (closed[index]) this.onCapacityAvailable(entry.parent.parentAppSessionId);
    });
  }

  private armRetry(): void {
    if (this.stopped) return;
    let due: number | undefined;
    for (const entry of this.pending.values()) {
      if (entry.closing || entry.retryAt === undefined) continue;
      if (due === undefined || entry.retryAt < due) due = entry.retryAt;
    }
    this.timer.armFor(due, this.d.now());
  }
}
