import { homedir } from 'node:os';
import { join } from 'node:path';

export function droidexUserDataDir(): string {
  return (
    process.env.DROIDEX_USER_DATA_DIR ??
    join(homedir(), 'Library', 'Application Support', 'DROIDEX')
  );
}

// Separate dev instances need separate writers; raw Factory transcripts remain shared.
export function droidexHistoryDir(): string {
  const configured = process.env.DROIDEX_HISTORY_DIR;
  if (configured !== undefined && configured !== '') return configured;
  return join(homedir(), '.factory', 'droidex');
}
