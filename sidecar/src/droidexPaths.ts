import { homedir } from 'node:os';
import { join } from 'node:path';

function nonEmptyEnv(value: string | undefined, fallback: string): string {
  if (!value?.trim()) return fallback;
  return value;
}

export function droidexUserDataDir(): string {
  return nonEmptyEnv(
    process.env.DROIDEX_USER_DATA_DIR,
    join(homedir(), 'Library', 'Application Support', 'DROIDEX'),
  );
}

// Instance-private state that cannot be shared between two running instances:
// the history index enforces a single-writer lease, so a dev instance launched
// with DROIDEX_USER_DATA_DIR needs its own copy beside its profile instead of
// fighting the main app over ~/.factory/droidex. The Electron main process sets
// DROIDEX_HISTORY_DIR only when the profile dir was explicitly overridden; every
// other launcher (production default, bare sidecar runs) keeps ~/.factory/droidex.
// Blank and whitespace-only values are treated as unset because .env.example
// documents empty assignments. Resolved per call because tests steer HOME at runtime.
export function droidexHistoryDir(): string {
  return nonEmptyEnv(process.env.DROIDEX_HISTORY_DIR, join(homedir(), '.factory', 'droidex'));
}
