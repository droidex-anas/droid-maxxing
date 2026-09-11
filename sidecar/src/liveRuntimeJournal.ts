import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ChildStatus, SessionPhase } from './protocol.js';

const JOURNAL_NAME = 'live-runtime.json';

export interface LiveSessionIdentity {
  appSessionId: string;
  providerSessionId: string;
  phase: SessionPhase;
  streaming: boolean;
  // When the session last did anything. Adoption needs it to tell a session
  // worth a provider process from one the first retirement sweep would
  // release, and a session that never produced a transcript has no persisted
  // summary to read it from.
  lastActiveAt: number;
}

export interface LiveChildIdentity {
  parentAppSessionId: string;
  childSessionId: string;
  providerSessionId?: string;
  status: ChildStatus;
}

// A process the agent spawned, recorded so a sidecar that died without
// running its cleanup can still reap what it left behind. `startedAt` is the
// guard against a recycled pid.
export interface LiveProcessIdentity {
  appSessionId: string;
  pid: number;
  startedAt: number;
}

export interface LiveRuntimeIdentities {
  sessions: LiveSessionIdentity[];
  children: LiveChildIdentity[];
  processes: LiveProcessIdentity[];
}

// Test-harness trap: a SessionManager built without an explicit user data
// directory journals to `DROIDEX_USER_DATA_DIR`, so a stale `live-runtime.json`
// left there by a manual run makes every later suite run adopt sessions the
// test never created. It shows up as unrelated tests failing on phantom
// sessions. Unset the variable, or point it at a fresh directory per run.
export function liveRuntimeJournalPath(userDataDir: string): string {
  return join(userDataDir, JOURNAL_NAME);
}

export class LiveRuntimeJournal {
  constructor(private readonly filePath: string) {}

  read(): LiveRuntimeIdentities {
    if (!existsSync(this.filePath)) return emptyIdentities();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return sanitizeIdentities(parsed);
    } catch {
      return emptyIdentities();
    }
  }

  write(identities: LiveRuntimeIdentities): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(sanitizeIdentities(identities)));
  }
}

function emptyIdentities(): LiveRuntimeIdentities {
  return { sessions: [], children: [], processes: [] };
}

function sanitizeIdentities(value: unknown): LiveRuntimeIdentities {
  if (typeof value !== 'object' || value === null) return emptyIdentities();
  const record = value as { sessions?: unknown; children?: unknown; processes?: unknown };
  return {
    sessions: Array.isArray(record.sessions)
      ? record.sessions.flatMap((entry) => {
          const session = sessionIdentity(entry);
          return session ? [session] : [];
        })
      : [],
    children: Array.isArray(record.children)
      ? record.children.flatMap((entry) => {
          const child = childIdentity(entry);
          return child ? [child] : [];
        })
      : [],
    processes: Array.isArray(record.processes)
      ? record.processes.flatMap((entry) => {
          const spawned = processIdentity(entry);
          return spawned ? [spawned] : [];
        })
      : [],
  };
}

function processIdentity(value: unknown): LiveProcessIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<LiveProcessIdentity>;
  if (typeof record.appSessionId !== 'string' || record.appSessionId.length === 0) return null;
  // A non-positive or non-finite pid would signal a process group on `kill`.
  if (!isPositiveNumber(record.pid) || !isPositiveNumber(record.startedAt)) return null;
  return { appSessionId: record.appSessionId, pid: record.pid, startedAt: record.startedAt };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sessionIdentity(value: unknown): LiveSessionIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<LiveSessionIdentity>;
  if (typeof record.appSessionId !== 'string' || record.appSessionId.length === 0) return null;
  if (typeof record.providerSessionId !== 'string' || record.providerSessionId.length === 0) {
    return null;
  }
  if (typeof record.phase !== 'string') return null;
  if (typeof record.lastActiveAt !== 'number' || !Number.isFinite(record.lastActiveAt)) return null;
  return {
    appSessionId: record.appSessionId,
    providerSessionId: record.providerSessionId,
    phase: record.phase,
    streaming: record.streaming === true,
    lastActiveAt: record.lastActiveAt,
  };
}

function childIdentity(value: unknown): LiveChildIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<LiveChildIdentity>;
  if (typeof record.parentAppSessionId !== 'string' || record.parentAppSessionId.length === 0) {
    return null;
  }
  if (typeof record.childSessionId !== 'string' || record.childSessionId.length === 0) return null;
  if (typeof record.status !== 'string') return null;
  return {
    parentAppSessionId: record.parentAppSessionId,
    childSessionId: record.childSessionId,
    ...(typeof record.providerSessionId === 'string' && record.providerSessionId.length > 0
      ? { providerSessionId: record.providerSessionId }
      : {}),
    status: record.status,
  };
}
