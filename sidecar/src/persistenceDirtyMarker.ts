import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

import type { PersistenceRecovery } from './protocol.js';

const MARKER_NAME = 'history-unflushed.marker';

export function persistenceDirtyMarkerPath(userDataDir: string): string {
  return join(userDataDir, MARKER_NAME);
}

export class PersistenceDirtyMarker {
  private dirty = false;
  private previous: PersistenceRecovery;

  constructor(
    private readonly filePath: string,
    private readonly processId = process.pid,
    private readonly isAlive: (processId: number) => boolean = isProcessAlive,
  ) {
    this.previous = readPreviousUnflushedWork(filePath, processId, isAlive);
  }

  recovery(): PersistenceRecovery {
    return { ...this.previous };
  }

  markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    writeMarker(this.filePath, this.processId);
  }

  markClean(): void {
    this.dirty = false;
    this.previous = { durable: true, hadUnflushedWork: false };
    removeMarker(this.filePath);
  }
}

function readPreviousUnflushedWork(
  filePath: string,
  currentProcessId: number,
  isAlive: (processId: number) => boolean,
): PersistenceRecovery {
  const parsed = readMarker(filePath);
  if (!parsed) return { durable: true, hadUnflushedWork: false };
  if (parsed.processId === currentProcessId) {
    return { durable: false, hadUnflushedWork: true };
  }
  if (isAlive(parsed.processId)) {
    return {
      durable: false,
      hadUnflushedWork: true,
      message: 'History durability is owned by another live sidecar process.',
    };
  }
  return {
    durable: false,
    hadUnflushedWork: true,
    message:
      'The previous agent runtime exited with unflushed history. Restored sessions use the last durable snapshot; in-flight work was not written.',
  };
}

function readMarker(filePath: string): { processId: number } | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('processId' in parsed)) return null;
    const processId = parsed.processId;
    if (typeof processId !== 'number' || !Number.isSafeInteger(processId) || processId <= 0) {
      return null;
    }
    return { processId };
  } catch {
    return {
      processId: 0,
    };
  }
}

function writeMarker(filePath: string, processId: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ processId, updatedAt: Date.now() }));
}

function removeMarker(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isProcessAlive(processId: number): boolean {
  if (processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}
