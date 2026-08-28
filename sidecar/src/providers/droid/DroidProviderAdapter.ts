import {
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
  type RuntimeHandlers,
} from './DroidModeMapping.js';
import { readContextBreakdown, type FactorySession } from './DroidFactorySession.js';
import { DroidProviderSession } from './DroidProviderSession.js';

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

  constructor(options: DroidAdapterOptions = {}) {
    assertDefinitionConsistency(DROID_DEFINITION);
    this.#options = options;
    this.#runtime = options.runtime ?? new DroidRuntime();
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
    const session = new DroidProviderSession(input, {
      providerSessionId: input.ids.nextProviderSessionId(),
      ...(resumeSessionId
        ? { resumeState: { schemaVersion: 1 as const, sessionId: resumeSessionId } }
        : {}),
    });
    this.sessions.push(session);
    const handlers = createDroidNativeHandlers(session);
    try {
      const factory = resumeSessionId
        ? await this.#runtime.loadSession(resumeSessionId, {
            cwd: input.cwd,
            permissionHandler: handlers.permissionHandler,
            askUserHandler: handlers.askUserHandler,
          })
        : await this.#runtime.createSession(createOptionsFromInput(input, handlers));
      if (session.failedOpen) {
        await factory.close();
        throw session.openError;
      }
      session.bindFactorySession(factory);
      if (session.failedOpen) {
        await session.close(ShutdownDeadline.fromDurationMs(0));
        throw session.openError;
      }
      return session;
    } catch (error) {
      if (!session.isClosed) {
        await session.close(ShutdownDeadline.fromDurationMs(0));
      }
      if (error instanceof ProviderContractError) throw error;
      throw createProviderContractError(
        'droid',
        'native_session_start_failed',
        'Droid session failed to start.',
        'retry_session',
      );
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
): CreateRuntimeSessionOptions {
  const reasoning = droidReasoningEffortFromSelection(input.configuration.providerSelection);
  return {
    cwd: input.cwd,
    interactionMode: input.configuration.interactionMode,
    modelId: input.configuration.providerSelection.modelId,
    autonomyLevel: input.configuration.autonomy,
    permissionHandler: handlers.permissionHandler,
    askUserHandler: handlers.askUserHandler,
    ...(reasoning === undefined ? {} : { reasoningEffort: reasoning }),
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
