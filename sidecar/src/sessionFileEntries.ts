import type { SessionFileCacheEntry } from './sessionFileCache.js';

export function copySessionFileEntry(entry: SessionFileCacheEntry): SessionFileCacheEntry {
  return {
    ...entry,
    summary: entry.summary ? structuredClone(entry.summary) : null,
    ...(entry.launchSettings ? { launchSettings: { ...entry.launchSettings } } : {}),
  };
}

export function mapSessionFileEntries(
  entries: Iterable<SessionFileCacheEntry>,
): Map<string, SessionFileCacheEntry> {
  const files = new Map<string, SessionFileCacheEntry>();
  for (const entry of entries) files.set(entry.providerSessionId, copySessionFileEntry(entry));
  return files;
}

export function applySessionFileEntries(
  files: Map<string, SessionFileCacheEntry>,
  upserts: readonly SessionFileCacheEntry[],
  removedProviderSessionIds: readonly string[],
): void {
  for (const providerSessionId of removedProviderSessionIds) files.delete(providerSessionId);
  for (const entry of upserts) files.set(entry.providerSessionId, copySessionFileEntry(entry));
}

export function sameSessionFileEntries(
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
