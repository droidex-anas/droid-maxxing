import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';
import { TranscriptStore } from './persistence/TranscriptStore.js';
import type { SessionCreatePersistence } from './sessionCreateIdentity.js';

export interface CanonicalStoreDependencies {
  database?: Pick<DroidexDatabase, 'close'>;
  nextAppSessionId?: SessionCreatePersistence['nextAppSessionId'];
  nextTurnId?: SessionCreatePersistence['nextTurnId'];
  onCreateBoundary?: SessionCreatePersistence['onCreateBoundary'];
  nextId?: SessionCreatePersistence['nextId'];
}

export function bindCanonicalStores(
  dependencies: CanonicalStoreDependencies | undefined,
  options: { createIfMissing?: boolean } = {},
): {
  database: Pick<DroidexDatabase, 'close'> | undefined;
  lifecycle: SessionCreatePersistence;
} {
  const provided = dependencies?.database;
  const db =
    provided instanceof DroidexDatabase
      ? provided
      : options.createIfMissing
        ? new DroidexDatabase()
        : undefined;
  if (!db) {
    return {
      database: provided,
      lifecycle: identityHooks(dependencies),
    };
  }
  return {
    database: db,
    lifecycle: {
      sessionStore: new SessionStore(db),
      transcriptStore: new TranscriptStore(db),
      atomic: (work) => db.atomic(work),
      ...identityHooks(dependencies),
    },
  };
}

function identityHooks(
  dependencies: CanonicalStoreDependencies | undefined,
): SessionCreatePersistence {
  return {
    ...(dependencies?.nextAppSessionId ? { nextAppSessionId: dependencies.nextAppSessionId } : {}),
    ...(dependencies?.nextTurnId ? { nextTurnId: dependencies.nextTurnId } : {}),
    ...(dependencies?.onCreateBoundary ? { onCreateBoundary: dependencies.onCreateBoundary } : {}),
    ...(dependencies?.nextId ? { nextId: dependencies.nextId } : {}),
  };
}
