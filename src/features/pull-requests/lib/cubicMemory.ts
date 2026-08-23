// Cubic runs on GitHub, so the app can only observe it: once a review or a
// comment from Cubic is seen on a repository, that repository is remembered and
// the "Enable Cubic" invitation never comes back for it.
const KEY_PREFIX = 'droid-pr-cubic-repo:';

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

export function isCubicRemembered(repoKey: string | null): boolean {
  if (!repoKey) return false;
  try {
    return getLocalStorage()?.getItem(KEY_PREFIX + repoKey) === '1';
  } catch {
    // Storage unavailable: fall back to offering the invitation.
    return false;
  }
}

export function rememberCubic(repoKey: string | null): void {
  if (!repoKey) return;
  try {
    getLocalStorage()?.setItem(KEY_PREFIX + repoKey, '1');
  } catch {
    /* ignore */
  }
}
