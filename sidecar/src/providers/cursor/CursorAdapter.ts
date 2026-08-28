// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/CursorAdapter.ts
// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/CursorProvider.ts
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
  type ProviderSessionCreateInput,
  type ProviderSessionResumeInput,
  type ProviderSnapshot,
} from '../providerTypes.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import {
  buildCursorSnapshot,
  defaultCursorCommandRunner,
  fallbackCursorModel,
  missingCursorExecutableSnapshot,
  parseCursorAboutOutput,
  parseCursorModelCatalog,
  runCursorAbout,
  unavailableCursorSnapshot,
  type CursorCommandRunner,
} from './cursorDiscovery.js';
import {
  CURSOR_ABOUT_TIMEOUT_MS,
  CURSOR_DEFAULT_BINARY,
  CURSOR_DEFINITION,
  CURSOR_MODEL_DISCOVERY_TIMEOUT_MS,
  CURSOR_SESSION_LOAD_TIMEOUT_MS,
  buildCursorAcpSpawn,
  buildCursorHandshake,
  parseAdvertisedModes,
  parseCursorResumeState,
} from './cursorHandshake.js';
import { CursorProviderSession, type CursorAcpClient } from './cursorSession.js';

export type CursorAcpConnector = (options: AcpConnectionOptions) => Promise<CursorAcpClient>;

export interface CursorAdapterOptions {
  binaryPath?: string;
  apiEndpoint?: string;
  env?: NodeJS.ProcessEnv;
  spawnAcp?: AcpProcessSpawnRequest;
  runCommand?: CursorCommandRunner;
  connectAcp?: CursorAcpConnector;
  aboutTimeoutMs?: number;
  modelDiscoveryTimeoutMs?: number;
  sessionLoadTimeoutMs?: number;
}

export class CursorProviderAdapter implements ProviderAdapter {
  readonly definition = CURSOR_DEFINITION;
  readonly sessions: CursorProviderSession[] = [];
  receivedCloseDeadline: ShutdownDeadline | undefined;
  #revision = 0;
  readonly #options: CursorAdapterOptions;
  readonly #runCommand: CursorCommandRunner;
  readonly #connectAcp: CursorAcpConnector;

  constructor(options: CursorAdapterOptions = {}) {
    assertDefinitionConsistency(CURSOR_DEFINITION);
    this.#options = options;
    this.#runCommand = options.runCommand ?? defaultCursorCommandRunner;
    this.#connectAcp = options.connectAcp ?? ((input) => AcpConnection.connect(input));
  }

  async probe(signal: AbortSignal): Promise<ProviderSnapshot> {
    this.#revision += 1;
    const revision = this.#revision;
    if (signal.aborted) {
      throw createProviderContractError(
        'cursor',
        'stale_provider_operation',
        'Cursor discovery was cancelled.',
        'refresh',
      );
    }
    const command = this.#options.binaryPath?.trim() || CURSOR_DEFAULT_BINARY;
    try {
      const about = await runCursorAbout({
        command,
        runCommand: this.#runCommand,
        timeoutMs: this.#options.aboutTimeoutMs ?? CURSOR_ABOUT_TIMEOUT_MS,
        signal,
      });
      if (about.timedOut) {
        return unavailableCursorSnapshot(revision, 'Cursor Agent timed out while running `about`.');
      }
      const parsed = parseCursorAboutOutput(about);
      if (parsed.auth.status === 'unauthenticated') {
        return buildCursorSnapshot({
          revision,
          parsed,
          models: [fallbackCursorModel()],
          advertisedModes: [],
        });
      }
      const discovered = await this.#discoverModels(signal);
      return buildCursorSnapshot({
        revision,
        parsed,
        models: discovered.models,
        advertisedModes: discovered.advertisedModes,
      });
    } catch (error) {
      if (error instanceof ProviderContractError && error.code === 'missing_executable') {
        return missingCursorExecutableSnapshot(revision);
      }
      if (error instanceof ProviderContractError) {
        throw error;
      }
      return unavailableCursorSnapshot(revision, 'Cursor Agent discovery failed.');
    }
  }

  async create(input: ProviderSessionCreateInput): Promise<CursorProviderSession> {
    assertCreateInputMatchesAdapter(this.definition, input);
    return this.#openSession(input);
  }

  async resume(input: ProviderSessionResumeInput): Promise<CursorProviderSession> {
    assertCreateInputMatchesAdapter(this.definition, input);
    const resumeState = parseCursorResumeState(input.resumeState);
    if (!resumeState) {
      throw createProviderContractError(
        'cursor',
        'invalid_provider_configuration',
        'Cursor resume state is invalid.',
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
  ): Promise<CursorProviderSession> {
    const session = new CursorProviderSession(input, {
      providerSessionId: input.ids.nextProviderSessionId(),
      ...(resumeSessionId ? { resumeState: { schemaVersion: 1, sessionId: resumeSessionId } } : {}),
    });
    this.sessions.push(session);
    const spawn =
      this.#options.spawnAcp ??
      buildCursorAcpSpawn({
        binaryPath: this.#options.binaryPath,
        apiEndpoint: this.#options.apiEndpoint,
        cwd: input.cwd,
        env: this.#options.env,
      });
    try {
      const connection = await this.#connectWithLoadBudget({
        providerInstanceId: 'cursor',
        spawn,
        handshake: buildCursorHandshake({ cwd: input.cwd, resumeSessionId }),
        onNotification: (notification) => session.onAcpNotification(notification),
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
      throw mapAdapterError(
        error,
        'native_session_start_failed',
        'Cursor session failed to start.',
      );
    }
  }

  async #discoverModels(signal: AbortSignal): Promise<{
    models: ReturnType<typeof parseCursorModelCatalog>;
    advertisedModes: ReturnType<typeof parseAdvertisedModes>;
  }> {
    const spawn =
      this.#options.spawnAcp ??
      buildCursorAcpSpawn({
        binaryPath: this.#options.binaryPath,
        apiEndpoint: this.#options.apiEndpoint,
        cwd: process.cwd(),
        env: this.#options.env,
      });
    const timeoutMs = this.#options.modelDiscoveryTimeoutMs ?? CURSOR_MODEL_DISCOVERY_TIMEOUT_MS;
    let connection: CursorAcpClient | undefined;
    try {
      connection = await this.#connectAcp({
        providerInstanceId: 'cursor',
        spawn,
        handshake: buildCursorHandshake({ cwd: process.cwd() }),
      });
      if (signal.aborted) {
        throw createProviderContractError(
          'cursor',
          'stale_provider_operation',
          'Cursor discovery was cancelled.',
          'refresh',
        );
      }
      const response = await withTimeout(
        connection.request('cursor/list_available_models', {}),
        timeoutMs,
        'Cursor model discovery timed out.',
      );
      return {
        models: parseCursorModelCatalog(response),
        advertisedModes: parseAdvertisedModes(connection.sessionSetupResult),
      };
    } catch (error) {
      if (error instanceof ProviderContractError && error.code === 'stale_provider_operation') {
        throw error;
      }
      return { models: [fallbackCursorModel()], advertisedModes: [] };
    } finally {
      if (connection) {
        await connection.close(ShutdownDeadline.fromDurationMs(0));
      }
    }
  }

  async #connectWithLoadBudget(options: AcpConnectionOptions): Promise<CursorAcpClient> {
    const timeoutMs = this.#options.sessionLoadTimeoutMs ?? CURSOR_SESSION_LOAD_TIMEOUT_MS;
    if (!options.handshake.resumeSessionId) {
      return this.#connectAcp(options);
    }
    return withTimeout(this.#connectAcp(options), timeoutMs, 'Cursor session load timed out.');
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
  return createProviderContractError('cursor', code, fallback, 'retry_session');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        createProviderContractError('cursor', 'unavailable_provider_instance', message, 'refresh'),
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
