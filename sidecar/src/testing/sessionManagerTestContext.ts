import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { McpServerConfigSchema, type McpServerConfig } from '@factory/droid-sdk';

import { childPersistenceFromStore } from '../childCanonicalPersistence.js';
import type { PersistedChildSession } from '../ChildSessionState.js';
import type { ShutdownDeadline } from '../providers/shutdownDeadline.js';
import {
  SessionManager,
  type SessionManagerDependencies,
  type StartableLocalMcpResource,
} from '../SessionManager.js';
import type * as Protocol from '../protocol.js';
import { DroidexDatabase } from '../persistence/DroidexDatabase.js';
import { SessionStore, type StoredSession } from '../persistence/SessionStore.js';
import { TranscriptStore } from '../persistence/TranscriptStore.js';
import { FakeBrowserSessionManager } from './browserCharacterizationSupport.js';
import {
  FakeFactoryRuntime,
  type FakeFactorySession,
  type RecordedCall,
  type StreamGate,
} from './fakeFactoryRuntime.js';
import { FakeHistoryIndex } from './historyCharacterizationSupport.js';

/* eslint-disable @typescript-eslint/dot-notation -- ProcessEnv requires indexed access under strict TypeScript. */

const INITIAL_MODELS: Protocol.ModelInfo[] = [
  {
    id: 'model-default',
    displayName: 'Default',
    isCustom: false,
    maxContextTokens: 1_000,
  },
];

const LOCAL_MCP_CONFIG = McpServerConfigSchema.parse({
  type: 'http',
  name: 'test-browser',
  url: 'http://127.0.0.1/test',
});

const CLI_MCP_CONFIG = McpServerConfigSchema.parse({
  type: 'http',
  name: 'test-cli',
  url: 'https://mcp.example.test/mcp',
});

export interface SessionManagerTestContext {
  readonly events: Protocol.ServerEvent[];
  readonly calls: RecordedCall[];
  readonly runtime: FakeFactoryRuntime;
  readonly provider: {
    session(id: string): FakeFactorySession;
    deferNextStream(id: string): StreamGate;
    deferNextCompaction(id: string): StreamGate;
    deferNextContextStats(id: string): StreamGate;
    deferNextUpdateSettings(id: string): StreamGate;
    waitForPrompts(id: string, count: number): Promise<void>;
    emitNotification(id: string, note: Record<string, unknown>): void;
  };
  readonly history: FakeHistoryIndex;
  readonly fixture: {
    seedHistorySummaries(summaries: Protocol.SessionSummary[]): void;
    seedChildSessions(children: Protocol.ChildSessionSummary[]): void;
    childRecords(parentAppSessionId: string): PersistedChildSession[];
    childRecord(
      parentAppSessionId: string,
      childSessionId: string,
    ): PersistedChildSession | undefined;
    storedSession(appSessionId: string): StoredSession | undefined;
    publishSessionFiles(): void;
  };
  readonly browsers: FakeBrowserSessionManager;
  readonly home: string;
  readonly mcpServerCloseCalls: number;
  handle(command: Protocol.ClientCommand): Promise<void>;
  create(
    command: Omit<Extract<Protocol.ClientCommand, { type: 'session.create' }>, 'type'>,
  ): Promise<void>;
  retireIdleSessionRuntimes(): Promise<void>;
  shutdown(deadline?: ShutdownDeadline): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface NativeBrowserTestContext {
  readonly events: Protocol.ServerEvent[];
  handle(command: Protocol.ClientCommand): Promise<void>;
  dispose(): Promise<void>;
}

export function createSessionManagerTestContext(
  options: {
    defaults?: Protocol.FactoryDefaultSettings;
    getFactoryDefaults?: () => Promise<Protocol.FactoryDefaultSettings>;
    readLaunchSettings?: SessionManagerDependencies['readLaunchSettings'];
    streamingCoalesceMs?: number;
    childRuntimeIdleMs?: number;
    sessionRuntimeIdleMs?: number;
    providerRegistry?: SessionManagerDependencies['providerRegistry'];
    database?: SessionManagerDependencies['database'];
    nextAppSessionId?: SessionManagerDependencies['nextAppSessionId'];
    nextTurnId?: SessionManagerDependencies['nextTurnId'];
    onCreateBoundary?: SessionManagerDependencies['onCreateBoundary'];
  } = {},
): SessionManagerTestContext {
  const calls: RecordedCall[] = [];
  const events: Protocol.ServerEvent[] = [];
  const recordEvent = (event: Protocol.ServerEvent): void => {
    events.push(event);
    calls.push({ target: 'protocol', method: 'event', args: [event] });
  };
  const home = createTestHome(options.defaults);
  const runtime = new FakeFactoryRuntime(calls);
  const history = new FakeHistoryIndex(calls);
  const browsers = new FakeBrowserSessionManager((call) => calls.push(call), recordEvent);
  let childSequence = 0;
  const dependencies: SessionManagerDependencies = {
    runtime,
    browsers,
    createLocalMcpResource: () => new FakeLocalMcpResource(calls),
    loadConfiguredMcpServers: () => [CLI_MCP_CONFIG],
    mcpConfiguration: {
      add: (server, cwd) => {
        calls.push({ target: 'runtime', method: 'mcp.addConfigured', args: [server, cwd] });
        return Promise.resolve();
      },
      remove: (serverName, cwd) => {
        calls.push({ target: 'runtime', method: 'mcp.removeConfigured', args: [serverName, cwd] });
        return Promise.resolve();
      },
    },
    nextChildSessionId: () => `child-${String(++childSequence)}`,
    nextAppSessionId:
      options.nextAppSessionId ??
      (() => {
        const queued = runtime.createQueue[0];
        if (queued && typeof queued === 'object' && 'sessionId' in queued) {
          return queued.sessionId;
        }
        return `provider-${String(runtime.createCalls.length + 1)}`;
      }),
    ...(options.nextTurnId ? { nextTurnId: options.nextTurnId } : {}),
    ...(options.onCreateBoundary ? { onCreateBoundary: options.onCreateBoundary } : {}),
    // Pin live runtimes at the hard-open maximum so eviction races stay valid
    // even if a host lowers DROID_CONTROL_MAX_LIVE_CHILD_RUNTIMES.
    maxLiveRuntimes: 4,
    maxQueuedRuntimes: 16,
    // Zero means "anything already settled is retirable now", so retirement
    // tests drive the real sweep without waiting on a clock.
    ...(options.childRuntimeIdleMs === undefined
      ? {}
      : { childRuntimeIdleMs: options.childRuntimeIdleMs }),
    ...(options.sessionRuntimeIdleMs === undefined
      ? {}
      : { sessionRuntimeIdleMs: options.sessionRuntimeIdleMs }),
    // Integration assertions read appended events synchronously; the timer
    // coalescing behavior is covered by SessionTimeline unit tests.
    streamingCoalesceMs: options.streamingCoalesceMs ?? 0,
    ...(options.getFactoryDefaults ? { getFactoryDefaults: options.getFactoryDefaults } : {}),
    readLaunchSettings:
      options.readLaunchSettings ??
      ((providerSessionId) => history.sessionLaunchSettings(providerSessionId)),
    ...(options.providerRegistry ? { providerRegistry: options.providerRegistry } : {}),
    ...(options.database ? { database: options.database } : {}),
  };

  try {
    pinTestHome(home);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  const database =
    options.database ??
    new DroidexDatabase(
      path.join(home, 'Library', 'Application Support', 'DROIDEX', 'state', 'droidex.sqlite'),
    );
  const sessionStore = database instanceof DroidexDatabase ? new SessionStore(database) : undefined;
  const rawTranscript =
    database instanceof DroidexDatabase ? new TranscriptStore(database) : undefined;
  dependencies.database = database;
  if (rawTranscript) {
    dependencies.transcriptStore = {
      beginTurn: (input) => rawTranscript.beginTurn(input),
      settleTurn: (turnId, input) => rawTranscript.settleTurn(turnId, input),
      page: (input) => rawTranscript.page(input),
      search: (query, isStale) =>
        history.searchImpl
          ? history.searchImpl(query, isStale)
          : rawTranscript.search(query, isStale),
      append: (event) => {
        const failure = history.recordEventErrorForText;
        if (failure && JSON.stringify(event).includes(failure.text)) {
          delete history.recordEventErrorForText;
          throw failure.error;
        }
        const persisted = rawTranscript.append(event);
        calls.push({ target: 'store', method: 'append', args: [event] });
        return persisted;
      },
    };
  }
  if (sessionStore) {
    const replaceProviderRuntime = sessionStore.replaceProviderRuntime.bind(sessionStore);
    sessionStore.replaceProviderRuntime = (
      appSessionId,
      expectedGeneration,
      providerSessionId,
      resumeState,
    ) => {
      const error = history.nextSyncError;
      if (error) {
        delete history.nextSyncError;
        throw error;
      }
      return replaceProviderRuntime(
        appSessionId,
        expectedGeneration,
        providerSessionId,
        resumeState,
      );
    };
    dependencies.sessionStore = sessionStore;
    const persistence = childPersistenceFromStore(sessionStore);
    history.persistChildSession = (child) => {
      const parent = sessionStore.get(child.parentAppSessionId);
      if (!parent) return;
      persistence.upsert(child, parent.binding);
    };
  }
  let manager: SessionManager;
  try {
    manager = new SessionManager(recordEvent, { dependencies, initialModels: INITIAL_MODELS });
  } catch (error) {
    if (!options.database && database instanceof DroidexDatabase) database.close();
    unpinTestHome();
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  const handle = async (command: Protocol.ClientCommand): Promise<void> => {
    await manager.handle(command);
    await Promise.resolve();
    await Promise.resolve();
  };
  const providerSession = (id: string): FakeFactorySession => {
    const session = runtime.sessions.get(id);
    if (!session) throw new Error(`Unknown fake provider session ${id}`);
    return session;
  };

  return {
    events,
    calls,
    runtime,
    provider: {
      session: providerSession,
      deferNextStream: (id) => providerSession(id).deferNextStream(),
      deferNextCompaction: (id) => providerSession(id).deferNextCompaction(),
      deferNextContextStats: (id) => providerSession(id).deferNextContextStats(),
      deferNextUpdateSettings: (id) => providerSession(id).deferNextUpdateSettings(),
      waitForPrompts: (id, count) => providerSession(id).waitForPrompts(count),
      emitNotification: (id, note) => {
        providerSession(id).emitNotification(note);
      },
    },
    history,
    fixture: {
      seedHistorySummaries: (summaries) => {
        history.seedSummaries(summaries);
        if (!sessionStore) return;
        for (const summary of summaries) {
          if (sessionStore.get(summary.appSessionId)) continue;
          sessionStore.createProvisional({
            appSessionId: summary.appSessionId,
            clientRef: `seed-${summary.appSessionId}`,
            summary,
          });
          if (summary.providerSessionId) {
            sessionStore.bindInitialProviderRuntime(
              summary.appSessionId,
              0,
              summary.providerSessionId,
              { schemaVersion: 1, sessionId: summary.providerSessionId },
            );
          }
          sessionStore.markStarted(summary.appSessionId);
        }
      },
      seedChildSessions: (children) => {
        const records = children.map((child) => {
          const seeded = child as Protocol.ChildSessionSummary & {
            providerSessionId?: string;
          };
          return {
            ...child,
            providerSessionId: seeded.providerSessionId ?? child.childSessionId,
            updatedAt: Date.now(),
          };
        });
        history.seedChildSessions(records);
      },
      childRecords: (parentAppSessionId: string) =>
        sessionStore ? childPersistenceFromStore(sessionStore).list(parentAppSessionId) : [],
      childRecord: (parentAppSessionId: string, childSessionId: string) =>
        sessionStore
          ? childPersistenceFromStore(sessionStore).get(parentAppSessionId, childSessionId)
          : undefined,
      storedSession: (appSessionId: string) => sessionStore?.get(appSessionId),
      publishSessionFiles: () => undefined,
    },
    browsers,
    home,
    get mcpServerCloseCalls() {
      return calls.filter((call) => call.target === 'cleanup' && call.method === 'mcp.close')
        .length;
    },
    handle,
    create: (command) => handle({ type: 'session.create', ...command }),
    retireIdleSessionRuntimes: () => manager.retireIdleSessionRuntimes(),
    shutdown: (deadline) => manager.shutdown(deadline),
    waitForIdle: () => new Promise((resolve) => setImmediate(resolve)),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await manager.shutdown();
      } catch {
        // A prior failed shutdown already reported to the caller. Dispose must
        // still unpin HOME and must not rethrow the shared rejected promise.
      } finally {
        unpinTestHome();
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

export function createNativeBrowserTestContext(): NativeBrowserTestContext {
  const events: Protocol.ServerEvent[] = [];
  const recordEvent = (event: Protocol.ServerEvent): void => {
    events.push(event);
  };
  const home = createTestHome();

  // Native request/result correlation is wired by SessionManager while it composes
  // BrowserSessionManager, so this one focused context intentionally uses that
  // production composition. It only exercises local browser messages under an
  // isolated HOME; no provider session or authenticated runtime is started.
  try {
    pinTestHome(home);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  let manager: SessionManager;
  try {
    manager = new SessionManager(recordEvent, { initialModels: INITIAL_MODELS });
  } catch (error) {
    unpinTestHome();
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  return {
    events,
    handle: async (command) => {
      await manager.handle(command);
      await Promise.resolve();
      await Promise.resolve();
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await manager.shutdown();
      } catch {
        // A prior failed shutdown already reported to the caller.
      } finally {
        unpinTestHome();
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

class FakeLocalMcpResource implements StartableLocalMcpResource {
  constructor(private readonly calls: RecordedCall[]) {}

  start(): Promise<McpServerConfig> {
    return Promise.resolve(LOCAL_MCP_CONFIG);
  }

  close(): Promise<void> {
    this.calls.push({ target: 'cleanup', method: 'mcp.close', args: [] });
    return Promise.resolve();
  }
}

function createTestHome(defaults?: Protocol.FactoryDefaultSettings): string {
  const home = mkdtempSync(path.join(tmpdir(), 'session-manager-test-'));
  writeDefaults(home, defaults);
  return home;
}

let pinnedTestHome: { home: string; previousHome: string | undefined } | undefined;

// The manager keeps reading $HOME after commands return (context pollers,
// learned-window retunes, defaults reloads), so the fake home stays pinned for
// the whole context lifetime. A per-command scope would let that async work
// read the developer's real ~/.factory/settings.json and leak machine-local
// compaction overrides into assertions.
function pinTestHome(home: string): void {
  if (pinnedTestHome) throw new Error('Concurrent SessionManager test homes are not supported.');
  pinnedTestHome = { home, previousHome: process.env['HOME'] };
  process.env['HOME'] = home;
}

function unpinTestHome(): void {
  if (!pinnedTestHome) throw new Error('SessionManager test HOME is not pinned.');
  const { previousHome } = pinnedTestHome;
  pinnedTestHome = undefined;
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
}

function writeDefaults(home: string, defaults?: Protocol.FactoryDefaultSettings): void {
  if (!defaults) return;
  const factoryDir = path.join(home, '.factory');
  mkdirSync(factoryDir, { recursive: true });
  writeFileSync(
    path.join(factoryDir, 'settings.json'),
    JSON.stringify({
      compactionModel: defaults.compactionModel,
      compactionTokenLimit: defaults.compactionTokenLimit,
      compactionTokenLimitPerModel: defaults.compactionTokenLimitPerModel,
      missionOrchestratorModel: defaults.missionOrchestratorModelId,
      missionOrchestratorReasoningEffort: defaults.missionOrchestratorReasoningEffort,
      sessionDefaultSettings: {
        model: defaults.modelId,
        reasoningEffort: defaults.reasoningEffort,
        compactionModel: defaults.compactionModel,
        autonomyLevel: defaults.autonomy,
        interactionMode: defaults.interactionMode,
        specModeModel: defaults.specModelId,
        specModeReasoningEffort: defaults.specReasoningEffort,
      },
      missionModelSettings: {
        workerModel: defaults.workerModelId,
        workerReasoningEffort: defaults.workerReasoningEffort,
        validationWorkerModel: defaults.validatorModelId,
        validationWorkerReasoningEffort: defaults.validatorReasoningEffort,
      },
    }),
  );
}
