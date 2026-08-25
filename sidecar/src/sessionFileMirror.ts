import type {
  SessionFileCacheEntry,
  SessionFileLaunchSettings,
  SessionFileReconciliation,
  SessionFileSnapshot,
} from './sessionFileCache.js';
import type { SessionSummary } from './protocol.js';

/** In-memory main-thread view of the index worker's revisioned file cache. */
export class SessionFileMirror {
  private readonly files = new Map<string, SessionFileCacheEntry>();
  private revisionValue = 0;

  get size(): number {
    return this.files.size;
  }

  get revision(): number {
    return this.revisionValue;
  }

  summaries(): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    for (const entry of this.files.values()) {
      if (entry.summary) summaries.push(structuredClone(entry.summary));
    }
    return summaries;
  }

  pathIndex(): Map<string, string> {
    return new Map(
      [...this.files.values()].map((entry) => [entry.providerSessionId, entry.path] as const),
    );
  }

  sessionLaunchSettings(providerSessionId: string): SessionFileLaunchSettings | undefined {
    const settings = this.files.get(providerSessionId)?.launchSettings;
    return settings ? { ...settings } : undefined;
  }

  applyReconciliation(result: SessionFileReconciliation): boolean {
    if (result.previousRevision !== this.revisionValue) return false;
    for (const providerSessionId of result.removedProviderSessionIds) {
      this.files.delete(providerSessionId);
    }
    for (const entry of result.upserts) {
      this.files.set(entry.providerSessionId, copyEntry(entry));
    }
    this.revisionValue = result.revision;
    return true;
  }

  replaceSnapshot(snapshot: SessionFileSnapshot): boolean {
    const changed =
      snapshot.revision !== this.revisionValue || !sameEntries(this.files, snapshot.entries);
    this.files.clear();
    for (const entry of snapshot.entries) {
      this.files.set(entry.providerSessionId, copyEntry(entry));
    }
    this.revisionValue = snapshot.revision;
    return changed;
  }
}

function copyEntry(entry: SessionFileCacheEntry): SessionFileCacheEntry {
  return {
    ...entry,
    summary: entry.summary ? structuredClone(entry.summary) : null,
  };
}

function sameEntries(
  current: ReadonlyMap<string, SessionFileCacheEntry>,
  next: readonly SessionFileCacheEntry[],
): boolean {
  if (current.size !== next.length) return false;
  for (const entry of next) {
    const existing = current.get(entry.providerSessionId);
    if (
      existing?.path !== entry.path ||
      existing.birthtimeMs !== entry.birthtimeMs ||
      existing.mtimeMs !== entry.mtimeMs ||
      existing.sizeBytes !== entry.sizeBytes ||
      existing.settingsMtimeMs !== entry.settingsMtimeMs ||
      JSON.stringify(existing.summary) !== JSON.stringify(entry.summary) ||
      JSON.stringify(existing.launchSettings) !== JSON.stringify(entry.launchSettings)
    )
      return false;
  }
  return true;
}
