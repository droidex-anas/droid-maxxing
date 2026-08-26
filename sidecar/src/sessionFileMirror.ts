import type {
  SessionFileCacheEntry,
  SessionFileLaunchSettings,
  SessionFileReconciliation,
  SessionFileSnapshot,
} from './sessionFileCache.js';
import {
  applySessionFileEntries,
  mapSessionFileEntries,
  sameSessionFileEntries,
} from './sessionFileEntries.js';
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
    applySessionFileEntries(this.files, result.upserts, result.removedProviderSessionIds);
    this.revisionValue = result.revision;
    return true;
  }

  replaceSnapshot(snapshot: SessionFileSnapshot): boolean {
    const changed =
      snapshot.revision !== this.revisionValue ||
      !sameSessionFileEntries(this.files, snapshot.entries);
    this.files.clear();
    for (const [id, entry] of mapSessionFileEntries(snapshot.entries)) this.files.set(id, entry);
    this.revisionValue = snapshot.revision;
    return changed;
  }
}
