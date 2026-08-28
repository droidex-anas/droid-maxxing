// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/GrokAdapter.ts
// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/GrokProvider.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { AcpConnection, type AcpConnectionOptions } from '../acp/AcpConnection.js';
import { AcpConnectionError } from '../acp/acpConnectionErrors.js';
import type { AcpProcessSpawnRequest } from '../acp/acpProcess.js';
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
import {
  buildGrokSnapshot,
  defaultGrokCommandRunner,
  fallbackGrokModel,
  missingGrokExecutableSnapshot,
  parseGenericCliVersion,
  parseGrokModelsFromSessionSetup,
  runGrokVersion,
  unavailableGrokSnapshot,
  type GrokCommandRunner,
} from './grokDiscovery.js';
import {
  GROK_DEFAULT_BINARY,
  GROK_DEFINITION,
  GROK_MODEL_DISCOVERY_TIMEOUT_MS,
  GROK_VERSION_TIMEOUT_MS,
  buildGrokAcpSpawn,
  buildGrokHandshake,
  parseGrokResumeState,
} from './grokHandshake.js';
import { GrokProviderSession, type GrokAcpClient, type GrokSessionOptions } from './grokSession.js';
import type { GrokTimer } from './grokWatchdog.js';

export type GrokAcpConnector = (options: AcpConnectionOptions) => Promise<GrokAcpClient>;

export interface GrokAdapterOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  spawnAcp?: AcpProcessSpawnRequest;
  runCommand?: GrokCommandRunner;
  connectAcp?: GrokAcpConnector;
  versionTimeoutMs?: number;
  modelDiscoveryTimeoutMs?: number;
  timer?: GrokTimer;
  inactivityMs?: number;
  activeToolInactivityMs?: number;
}

export class GrokProviderAdapter implements ProviderAdapter {
  readonly definition = GROK_DEFINITION;
  readonly sessions: GrokProviderSession[] = [];
  receivedCloseDeadline: ShutdownDeadline | undefined;
  #revision = 0;
  readonly #options: GrokAdapterOptions;
  readonly #runCommand: GrokCommandRunner;
  readonly #connectAcp: GrokAcpConnector;

  constructor(options: GrokAdapterOptions = {}) {
    assertDefinitionConsistency(GROK_DEFINITION);
    this.#options = options;
    this.#runCommand = options.runCommand ?? defaultGrokCommandRunner;
    this.#connectAcp = options.connectAcp ?? ((input) => AcpConnection.connect(input));
  }

  async probe(signal: AbortSignal): Promise<ProviderSnapshot> {
    this.#revision += 1;
    const revision = this.#revision;
    if (signal.aborted) {
      throw createProviderContractError(
        'grok',
        'stale_provider_operation',
        'Grok discovery was cancelled.',
        'refresh',
      );
    }
    const command = this.#options.binaryPath?.trim() || GROK_DEFAULT_BINARY;
    try {
      const versionResult = await runGrokVersion({
        command,
        runCommand: this.#runCommand,
        timeoutMs: this.#options.versionTimeoutMs ?? GROK_VERSION_TIMEOUT_MS,
        signal,
      });
      if (versionResult.timedOut) {
        return unavailableGrokSnapshot(revision, 'Grok CLI timed out while running `--version`.');
      }
      const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
      if (versionResult.code !== 0) {
        return unavailableGrokSnapshot(revision, 'Grok CLI failed to run.', version);
      }
      const models = await this.#discoverModels(signal);
      return buildGrokSnapshot({ revision, version, models });
    } catch (error) {
      if (error instanceof ProviderContractError && error.code === 'missing_executable') {
        return missingGrokExecutableSnapshot(revision);
      }
      if (error instanceof ProviderContractError) {
        throw error;
      }
      return unavailableGrokSnapshot(revision, 'Grok discovery failed.');
    }
  }

  async create(input: ProviderSessionCreateInput): Promise<GrokProviderSession> {
    assertCreateInputMatchesAdapter(this.definition, input);
    return this.#openSession(input);
  }

  async resume(input: ProviderSessionResumeInput): Promise<GrokProviderSession> {
    assertCreateInputMatchesAdapter(this.definition, input);
    const resumeState = parseGrokResumeState(input.resumeState);
    if (!resumeState) {
      throw createProviderContractError(
        'grok',
        'invalid_provider_configuration',
        'Grok resume state is invalid.',
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
  ): Promise<GrokProviderSession> {
    const sessionOptions: GrokSessionOptions = {
      providerSessionId: input.ids.nextProviderSessionId(),
      ...(resumeSessionId ? { resumeState: { schemaVersion: 1, sessionId: resumeSessionId } } : {}),
      ...(this.#options.timer ? { timer: this.#options.timer } : {}),
      ...(this.#options.inactivityMs !== undefined
        ? { inactivityMs: this.#options.inactivityMs }
        : {}),
      ...(this.#options.activeToolInactivityMs !== undefined
        ? { activeToolInactivityMs: this.#options.activeToolInactivityMs }
        : {}),
    };
    const session = new GrokProviderSession(input, sessionOptions);
    this.sessions.push(session);
    const env = this.#options.env ?? process.env;
    const spawn =
      this.#options.spawnAcp ??
      buildGrokAcpSpawn({
        binaryPath: this.#options.binaryPath,
        cwd: input.cwd,
        env,
        autonomy: input.configuration.autonomy,
      });
    try {
      const connection = await this.#connectAcp({
        providerInstanceId: 'grok',
        spawn,
        handshake: buildGrokHandshake({
          cwd: input.cwd,
          env,
          resumeSessionId,
        }),
        onNotification: (notification) => session.onAcpNotification(notification),
        onServerRequest: (request) => session.onAcpServerRequest(request),
      });
      if (session.failedOpen) {
        await connection.close(ShutdownDeadline.fromDurationMs(0));
        throw session.openError;
      }
      session.bindConnection(connection);
      if (session.failedOpen) {
        throw session.openError;
      }
      return session;
    } catch (error) {
      if (!session.isClosed) {
        await session.close(ShutdownDeadline.fromDurationMs(0));
      }
      throw mapAdapterError(error, 'native_session_start_failed', 'Grok session failed to start.');
    }
  }

  async #discoverModels(signal: AbortSignal): Promise<readonly ProviderModel[]> {
    const env = this.#options.env ?? process.env;
    const spawn =
      this.#options.spawnAcp ??
      buildGrokAcpSpawn({
        binaryPath: this.#options.binaryPath,
        cwd: process.cwd(),
        env,
      });
    const timeoutMs = this.#options.modelDiscoveryTimeoutMs ?? GROK_MODEL_DISCOVERY_TIMEOUT_MS;
    let connection: GrokAcpClient | undefined;
    try {
      connection = await withTimeout(
        this.#connectAcp({
          providerInstanceId: 'grok',
          spawn,
          handshake: buildGrokHandshake({ cwd: process.cwd(), env }),
        }),
        timeoutMs,
        'Grok model discovery timed out.',
      );
      if (signal.aborted) {
        throw createProviderContractError(
          'grok',
          'stale_provider_operation',
          'Grok discovery was cancelled.',
          'refresh',
        );
      }
      return parseGrokModelsFromSessionSetup(connection.sessionSetupResult);
    } catch (error) {
      if (error instanceof ProviderContractError && error.code === 'stale_provider_operation') {
        throw error;
      }
      return [fallbackGrokModel()];
    } finally {
      if (connection) {
        await connection.close(ShutdownDeadline.fromDurationMs(0));
      }
    }
  }
}

function mapAdapterError(
  error: unknown,
  code: 'native_session_start_failed' | 'incompatible_provider_protocol',
  fallback: string,
): ProviderContractError {
  if (error instanceof ProviderContractError) {
    return error;
  }
  if (error instanceof AcpConnectionError) {
    return new ProviderContractError(error.toProviderError());
  }
  return createProviderContractError('grok', code, fallback, 'retry_session');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        createProviderContractError('grok', 'unavailable_provider_instance', message, 'refresh'),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
