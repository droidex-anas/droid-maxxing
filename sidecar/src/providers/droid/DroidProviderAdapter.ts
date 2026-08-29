import {
  DecompSessionType,
  DroidClient,
  DroidSession,
  type DroidClientTransport,
  type LoadSessionRequestParams,
} from '@factory/droid-sdk';
import type { AskUserHandler, PermissionHandler } from '@factory/droid-sdk';

import {
  readDroidCliModelCatalog,
  readDroidCliModelCatalogCache,
  toProviderModels,
} from '../../DroidCliCatalog.js';
import { createDroidTransport } from '../../DroidTransport.js';
import {
  detectEnvironment,
  findInstalledDroidPath,
  resolveDroidPath,
  buildDroidInvocation,
} from '../../Environment.js';
import { droidReasoningEffortFromSelection } from '../providerIdentity.js';
import {
  ProviderContractError,
  assertCreateInputMatchesAdapter,
  assertDefinitionConsistency,
  createProviderContractError,
  type ProviderAdapter,
  type ProviderModel,
  type ProviderSessionCreateInput,
  type ProviderSessionResumeInput,
  type ProviderSnapshot,
} from '../providerTypes.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import { createDroidNativeHandlers } from './DroidInteractions.js';
import {
  DROID_DEFINITION,
  createInitializeSessionParams,
  droidCapabilities,
  parseDroidResumeState,
  type CreateRuntimeSessionOptions,
  type McpServerConfig,
  type RuntimeHandlers,
} from './DroidModeMapping.js';
import { readContextBreakdown, type FactorySession } from './DroidFactorySession.js';
import { DroidProviderSession } from './DroidProviderSession.js';

export interface DroidOpenedMcp {
  servers: Array<{ close(): Promise<void> }>;
  configs: unknown[];
}

const openedMcp = new WeakMap<DroidProviderSession, DroidOpenedMcp>();

export function takeDroidOpenedMcp(session: object): DroidOpenedMcp | undefined {
  if (!(session instanceof DroidProviderSession)) return undefined;
  const resources = openedMcp.get(session);
  if (resources) openedMcp.delete(session);
  return resources;
}

export function queueDroidOpenFromHint(
  adapter: ProviderAdapter,
  pendingAppSessionId: string,
  hint: {
    sessionPurpose?: string;
    mission?: {
      worker: { modelId: string; reasoningEffort?: CreateRuntimeSessionOptions['reasoningEffort'] };
      validator: {
        modelId: string;
        reasoningEffort?: CreateRuntimeSessionOptions['reasoningEffort'];
      };
    };
    compactionModel: string;
    compactionTokenLimit: number;
  },
): void {
  if (!(adapter instanceof DroidProviderAdapter)) return;
  adapter.queueNativeOpen(pendingAppSessionId, {
    ...(hint.sessionPurpose === 'mission-control'
      ? { decompSessionType: DecompSessionType.Orchestrator }
      : {}),
    ...(hint.mission
      ? {
          workerModelId: hint.mission.worker.modelId,
          ...(hint.mission.worker.reasoningEffort !== undefined
            ? { workerReasoningEffort: hint.mission.worker.reasoningEffort }
            : {}),
          validatorModelId: hint.mission.validator.modelId,
          ...(hint.mission.validator.reasoningEffort !== undefined
            ? { validatorReasoningEffort: hint.mission.validator.reasoningEffort }
            : {}),
        }
      : {}),
    compactionModel: hint.compactionModel,
    compactionTokenLimit: hint.compactionTokenLimit,
    compactionThresholdCheckEnabled: true,
  });
}

const EXEC_ARGS = ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'];
const SESSION_INIT_TIMEOUT_MS = 20_000;
const ignoreError = (): void => undefined;

export type { CreateRuntimeSessionOptions, RuntimeHandlers };
export { createInitializeSessionParams } from './DroidModeMapping.js';

export interface RuntimeStatus {
  mode: 'cli_auth';
  droidPath: string;
  apiKeyConfigured: boolean;
}

export interface FactoryRuntime {
  connect(apiKey?: string): void;
  status(): RuntimeStatus;
  createSession(options: CreateRuntimeSessionOptions): Promise<FactorySession>;
  loadSession(providerSessionId: string, handlers?: RuntimeHandlers): Promise<FactorySession>;
  readContextBreakdown(session: FactorySession): Promise<unknown>;
}

export interface DroidAdapterOptions {
  runtime?: FactoryRuntime;
  findInstalledPath?: () => string | undefined;
  readCatalog?: (droidPath: string) => Promise<ProviderModel[]>;
  readCatalogCache?: (droidPath: string) => ProviderModel[];
  detect?: (apiKeyConfigured: boolean) => Promise<{
    cli: { present: boolean; path: string; version?: string };
    auth: { apiKeyConfigured: boolean; loginPresent: boolean };
  }>;
  startLocalMcpServers?: (ref: { id: string }, cwd?: string) => Promise<DroidOpenedMcp>;
  makePermissionHandler?: (ref: { id: string }) => PermissionHandler;
  makeAskUserHandler?: (ref: { id: string }) => AskUserHandler;
}

export class DroidRuntime implements FactoryRuntime {
  private explicitApiKey = '';

  connect(apiKey?: string): void {
    if (apiKey) this.explicitApiKey = apiKey;
  }

  status(): RuntimeStatus {
    return {
      mode: 'cli_auth',
      droidPath: resolveDroidPath(),
      apiKeyConfigured: this.explicitApiKey.length > 0,
    };
  }

  readContextBreakdown(session: FactorySession): Promise<unknown> {
    return readContextBreakdown(session);
  }

  async createSession(options: CreateRuntimeSessionOptions): Promise<DroidSession> {
    const { client, transport } = await this.createClient(options.cwd, options);
    const params = createInitializeSessionParams(options);
    try {
      const init = await withTimeout(
        client.initializeSession(params),
        SESSION_INIT_TIMEOUT_MS,
        'initialize_session',
      );
      return new DroidSession(client, init.sessionId, init);
    } catch (err) {
      await transport.close().catch(ignoreError);
      throw err;
    }
  }

  async loadSession(sessionId: string, handlers: RuntimeHandlers = {}): Promise<DroidSession> {
    const { client, transport } = await this.createClient(handlers.cwd, handlers);
    const params: LoadSessionRequestParams = { sessionId };
    if (handlers.mcpServers?.length) params.mcpServers = handlers.mcpServers;
    try {
      const init = await withTimeout(
        client.loadSession(params),
        SESSION_INIT_TIMEOUT_MS,
        'load_session',
      );
      return new DroidSession(client, sessionId, init);
    } catch (err) {
      await transport.close().catch(ignoreError);
      throw err;
    }
  }

  private async createClient(
    cwd?: string,
    handlers: RuntimeHandlers = {},
  ): Promise<{ client: DroidClient; transport: DroidClientTransport }> {
    const { execPath, execArgs } = buildDroidInvocation(EXEC_ARGS);
    const transport = createDroidTransport({
      execPath,
      execArgs,
      cwd,
      env: this.env(),
    });
    await transport.connect();
    const client = new DroidClient({ transport });
    if (handlers.permissionHandler) client.setPermissionHandler(handlers.permissionHandler);
    if (handlers.askUserHandler) client.setAskUserHandler(handlers.askUserHandler);
    return { client, transport };
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    if (this.explicitApiKey) env.FACTORY_API_KEY = this.explicitApiKey;
    else delete env.FACTORY_API_KEY;
    return env;
  }
}

export class DroidProviderAdapter implements ProviderAdapter {
  readonly definition = DROID_DEFINITION;
  readonly sessions: DroidProviderSession[] = [];
  receivedCloseDeadline: ShutdownDeadline | undefined;
  #revision = 0;
  readonly #runtime: FactoryRuntime;
  readonly #options: DroidAdapterOptions;
  readonly #queuedNativeOpen = new Map<string, Partial<CreateRuntimeSessionOptions>>();

  constructor(options: DroidAdapterOptions = {}) {
    assertDefinitionConsistency(DROID_DEFINITION);
    this.#options = options;
    this.#runtime = options.runtime ?? new DroidRuntime();
  }

  queueNativeOpen(
    pendingAppSessionId: string,
    options: Partial<CreateRuntimeSessionOptions>,
  ): void {
    this.#queuedNativeOpen.set(pendingAppSessionId, options);
  }

  async probe(signal: AbortSignal): Promise<ProviderSnapshot> {
    this.#revision += 1;
    const revision = this.#revision;
    if (signal.aborted) {
      throw createProviderContractError(
        'droid',
        'stale_provider_operation',
        'Droid discovery was cancelled.',
        'refresh',
      );
    }
    const installed = (this.#options.findInstalledPath ?? findInstalledDroidPath)();
    if (!installed) return missingDroidSnapshot(revision);
    const detect = this.#options.detect ?? detectEnvironment;
    const environment = await detect(this.#runtime.status().apiKeyConfigured);
    if (signal.aborted) {
      throw createProviderContractError(
        'droid',
        'stale_provider_operation',
        'Droid discovery was cancelled.',
        'refresh',
      );
    }
    const models = await this.#readModels(installed);
    const snapshot = buildDroidSnapshot({
      revision,
      version: environment.cli.version,
      models,
      authenticated: environment.auth.loginPresent || environment.auth.apiKeyConfigured,
    });
    return snapshot;
  }

  async create(input: ProviderSessionCreateInput): Promise<DroidProviderSession> {
    assertCreateInputMatchesAdapter(this.definition, input);
    return this.#openSession(input);
  }

  async resume(input: ProviderSessionResumeInput): Promise<DroidProviderSession> {
    assertCreateInputMatchesAdapter(this.definition, input);
    const resumeState = parseDroidResumeState(input.resumeState);
    if (!resumeState) {
      throw createProviderContractError(
        'droid',
        'invalid_provider_configuration',
        'Droid resume state is invalid.',
        'retry_session',
      );
    }
    return this.#openSession(input, resumeState.sessionId);
  }

  async close(deadline: ShutdownDeadline): Promise<void> {
    this.receivedCloseDeadline = deadline;
    for (const session of [...this.sessions].reverse()) {
      await session.close(deadline);
    }
  }

  async #openSession(
    input: ProviderSessionCreateInput,
    resumeSessionId?: string,
  ): Promise<DroidProviderSession> {
    const pendingKey = input.target.kind === 'session' ? input.target.appSessionId : undefined;
    const extras = pendingKey ? this.#queuedNativeOpen.get(pendingKey) : undefined;
    if (pendingKey) this.#queuedNativeOpen.delete(pendingKey);
    const ref = {
      id:
        input.target.kind === 'session' && !input.target.appSessionId.startsWith('pending:')
          ? input.target.appSessionId
          : '',
    };
    const mcp = this.#options.startLocalMcpServers
      ? await this.#options.startLocalMcpServers(ref, extras?.cwd ?? input.cwd)
      : { servers: [], configs: extras?.mcpServers ?? [] };
    const session = new DroidProviderSession(input, {
      providerSessionId: input.ids.nextProviderSessionId(),
      ...(resumeSessionId
        ? { resumeState: { schemaVersion: 1 as const, sessionId: resumeSessionId } }
        : {}),
    });
    this.sessions.push(session);
    const native = createDroidNativeHandlers(session);
    const permissionHandler =
      this.#options.makePermissionHandler?.(ref) ?? native.permissionHandler;
    const askUserHandler = this.#options.makeAskUserHandler?.(ref) ?? native.askUserHandler;
    try {
      const factory = resumeSessionId
        ? await this.#runtime.loadSession(resumeSessionId, {
            cwd: extras?.cwd ?? input.cwd,
            permissionHandler,
            askUserHandler,
            ...(mcp.configs.length > 0 ? { mcpServers: mcp.configs as McpServerConfig[] } : {}),
          })
        : await this.#runtime.createSession(
            createOptionsFromInput(
              input,
              { permissionHandler, askUserHandler },
              {
                ...extras,
                cwd: extras?.cwd ?? input.cwd,
                ...(mcp.configs.length > 0 ? { mcpServers: mcp.configs as McpServerConfig[] } : {}),
              },
            ),
          );
      if (session.failedOpen) {
        await factory.close();
        throw session.openError;
      }
      session.attachFactory(factory);
      if (!ref.id) ref.id = session.providerSessionId;
      if (session.failedOpen) {
        await session.close(ShutdownDeadline.fromDurationMs(0));
        throw session.openError;
      }
      openedMcp.set(session, mcp);
      return session;
    } catch (error) {
      await Promise.all(mcp.servers.map((server) => server.close().catch(ignoreError)));
      if (!session.isClosed) {
        await session.close(ShutdownDeadline.fromDurationMs(0));
      }
      throw error;
    }
  }

  async #readModels(droidPath: string): Promise<readonly ProviderModel[]> {
    const readCatalog = this.#options.readCatalog;
    const readCache = this.#options.readCatalogCache;
    try {
      if (readCatalog) return await readCatalog(droidPath);
      return toProviderModels(await readDroidCliModelCatalog(droidPath));
    } catch {
      if (readCache) return readCache(droidPath);
      return toProviderModels(readDroidCliModelCatalogCache(droidPath));
    }
  }
}

function createOptionsFromInput(
  input: ProviderSessionCreateInput,
  handlers: { permissionHandler: PermissionHandler; askUserHandler: AskUserHandler },
  extras?: Partial<CreateRuntimeSessionOptions>,
): CreateRuntimeSessionOptions {
  const reasoning =
    extras?.reasoningEffort ??
    droidReasoningEffortFromSelection(input.configuration.providerSelection);
  const interactionMode = extras?.interactionMode ?? input.configuration.interactionMode;
  const modelId = extras?.modelId ?? input.configuration.providerSelection.modelId;
  const specModeModelId =
    extras?.specModeModelId ?? (interactionMode === 'spec' ? modelId : undefined);
  const specModeReasoningEffort =
    extras?.specModeReasoningEffort ?? (interactionMode === 'spec' ? reasoning : undefined);
  return {
    ...extras,
    cwd: extras?.cwd ?? input.cwd,
    interactionMode,
    modelId,
    autonomyLevel: extras?.autonomyLevel ?? input.configuration.autonomy,
    permissionHandler: handlers.permissionHandler,
    askUserHandler: handlers.askUserHandler,
    ...(reasoning === undefined ? {} : { reasoningEffort: reasoning }),
    ...(specModeModelId === undefined ? {} : { specModeModelId }),
    ...(specModeReasoningEffort === undefined ? {} : { specModeReasoningEffort }),
  };
}

function buildDroidSnapshot(input: {
  revision: number;
  version?: string;
  models: readonly ProviderModel[];
  authenticated: boolean;
}): ProviderSnapshot {
  const capabilities = droidCapabilities();
  if (!input.authenticated) {
    return {
      definition: DROID_DEFINITION,
      revision: input.revision,
      readiness: 'unauthenticated',
      executable: { name: 'droid', version: input.version ?? 'unknown' },
      models: input.models,
      capabilities,
      error: createProviderContractError(
        'droid',
        'unauthenticated_provider',
        'Droid is installed but not authenticated.',
        'open_droid_setup',
      ).toProviderError(),
    };
  }
  return {
    definition: DROID_DEFINITION,
    revision: input.revision,
    readiness: 'ready',
    executable: { name: 'droid', version: input.version ?? 'unknown' },
    auth: { apiProviderLabel: 'Factory' },
    models: input.models,
    capabilities,
  };
}

function missingDroidSnapshot(revision: number): ProviderSnapshot {
  const error = createProviderContractError(
    'droid',
    'missing_executable',
    'Droid CLI is not installed.',
    'open_droid_setup',
  ).toProviderError();
  return {
    definition: DROID_DEFINITION,
    revision,
    readiness: 'missing',
    models: [],
    capabilities: droidCapabilities(),
    error,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Droid ${label} timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
