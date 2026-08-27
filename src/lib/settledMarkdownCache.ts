import type { ReactElement } from 'react';

// Virtualizer mounts ~one viewport plus overscan. 48 parsed trees cover a few
// screens of back-scroll without retaining a whole transcript.
export const SETTLED_MARKDOWN_CACHE_LIMIT = 48;

interface CacheEntry {
  key: string;
  element: ReactElement;
}

const entries: CacheEntry[] = [];

export function contentHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function settledMarkdownCacheKey(cacheId: string, source: string, flags: string): string {
  return `${cacheId}:${contentHash(source)}:${flags}`;
}

export function getSettledMarkdownElement(key: string, create: () => ReactElement): ReactElement {
  const index = entries.findIndex((entry) => entry.key === key);
  if (index >= 0) {
    const hit = entries.splice(index, 1).at(0);
    if (!hit) return create();
    entries.push(hit);
    return hit.element;
  }
  const element = create();
  entries.push({ key, element });
  while (entries.length > SETTLED_MARKDOWN_CACHE_LIMIT) entries.shift();
  return element;
}

export function settledMarkdownCacheSize(): number {
  return entries.length;
}

export function resetSettledMarkdownCacheForTest(): void {
  entries.length = 0;
}

export function settledMarkdownFlags(options: {
  specMode: boolean;
  allowGeneratedContent: boolean;
  autoPlayAppBlocks: boolean;
  cutOffAppBlocks: boolean;
}): string {
  return [
    options.specMode ? 's' : 'c',
    options.allowGeneratedContent ? 'g' : '-',
    options.autoPlayAppBlocks ? 'a' : '-',
    options.cutOffAppBlocks ? 'x' : '-',
  ].join('');
}
