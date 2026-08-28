import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { McpServerConfigSchema, type McpServerConfig } from '@factory/droid-sdk';

import {
  SessionManager,
  type SessionManagerDependencies,
  type StartableLocalMcpResource,
} from '../SessionManager.js';
import { HistoryIndex } from '../history.js';
import type * as Protocol from '../protocol.js';
import type { SessionFileChange } from '../sessionFileCache.js';
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
    publishSessionFiles(changes: SessionFileChange[]): void;
  };
  readonly browsers: FakeBrowserSessionManager;
  readonly home: string;
  readonly mcpServerCloseCalls: number;
  handle(command: Protocol.ClientCommand): Promise<void>;
  create(
    command: Omit<Extract<Protocol.ClientCommand, { type: 'session.create' }>, 'type'>,
  ): Promise<void>;
  retireIdleSessionRuntimes(): Promise<void>;
  shutdown(): Promise<void>;
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
    startSessionFileWatcher?: SessionManagerDependencies['startSessionFileWatcher'];
    streamingCoalesceMs?: number;
    childRuntimeIdleMs?: number;
    sessionRuntimeIdleMs?: number;
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
    history,
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
    ...(options.startSessionFileWatcher
      ? { startSessionFileWatcher: options.startSessionFileWatcher }
      : {}),
  };

  try {
    pinTestHome(home);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  let sessionFileMirror: HistoryIndex;
  try {
    sessionFileMirror = new HistoryIndex();
  } catch (error) {
    unpinTestHome();
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  let sessionFileRevision = 0;
  let manager: SessionManager;
  try {
    manager = new SessionManager(recordEvent, { dependencies, initialModels: INITIAL_MODELS });
  } catch (error) {
    sessionFileMirror.close();
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
      },
      seedChildSessions: (children) => {
        history.seedChildSessions(
          children.map((child) => ({
            ...child,
            providerSessionId: child.childSessionId,
            updatedAt: Date.now(),
          })),
        );
      },
      publishSessionFiles: (changes) => {
        const upserts = changes.flatMap(({ providerSessionId, path: sessionPath }) => {
          if (!existsSync(sessionPath)) return [];
          const stat = statSync(sessionPath);
          return [
            {
              providerSessionId,
              path: sessionPath,
              birthtimeMs: stat.birthtimeMs,
              mtimeMs: stat.mtimeMs,
              sizeBytes: stat.size,
              settingsMtimeMs: null,
              summary: null,
            },
          ];
        });
        const removedProviderSessionIds = changes
          .filter(({ path: sessionPath }) => !existsSync(sessionPath))
          .map(({ providerSessionId }) => providerSessionId);
        const previousRevision = sessionFileRevision;
        sessionFileRevision += 1;
        const applied = sessionFileMirror.applySessionFileReconciliation({
          previousRevision,
          revision: sessionFileRevision,
          changed: upserts.length + removedProviderSessionIds.length,
          upserts,
          removedProviderSessionIds,
        });
        if (!applied) throw new Error('Test session-file mirror revision diverged.');
      },
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
    shutdown: () => manager.shutdown(),
    waitForIdle: () => new Promise((resolve) => setImmediate(resolve)),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await manager.shutdown();
      } finally {
        sessionFileMirror.close();
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
