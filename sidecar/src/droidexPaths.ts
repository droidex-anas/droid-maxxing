import { homedir } from 'node:os';
import { join } from 'node:path';

export function droidexUserDataDir(): string {
  return (
    process.env.DROIDEX_USER_DATA_DIR ??
    join(homedir(), 'Library', 'Application Support', 'DROIDEX')
  );
}

export function droidexDatabasePath(): string {
  return join(droidexUserDataDir(), 'state', 'droidex.sqlite');
}
