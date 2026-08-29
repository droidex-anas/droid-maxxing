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

export function abandonOwnedSidecarResources(
  resources: {
    closeBrowsers: () => Promise<unknown>;
  },
  bindError: unknown,
): never {
  void resources.closeBrowsers();
  throw bindError;
}

export function bindCanonicalStoresForManager(
  dependencies: CanonicalStoreDependencies | undefined,
  owned: { browsers: { closeAll(): Promise<unknown> } },
): ReturnType<typeof bindCanonicalStores> {
  try {
    return bindCanonicalStores(dependencies, { createIfMissing: !dependencies });
  } catch (error) {
    if (!dependencies) {
      abandonOwnedSidecarResources(
        {
          closeBrowsers: () => owned.browsers.closeAll(),
        },
        error,
      );
    }
    throw error;
  }
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

export function canonicalReadBindings(lifecycle: SessionCreatePersistence): {
  sessionStore?: SessionCreatePersistence['sessionStore'];
  transcriptStore?: SessionCreatePersistence['transcriptStore'];
} {
  return {
    ...(lifecycle.sessionStore ? { sessionStore: lifecycle.sessionStore } : {}),
    ...(lifecycle.transcriptStore ? { transcriptStore: lifecycle.transcriptStore } : {}),
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
