// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d packages/effect-acp/src/client.ts
// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/AcpSessionRuntime.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { z } from 'zod';

import type { ProviderError, ProviderErrorCode } from '../providerErrors.js';
import type { ProviderInstanceId } from '../providerIdentity.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import {
  AcpConnectionError,
  createAcpConnectionError,
  mapSpawnFailure,
} from './acpConnectionErrors.js';
import {
  decodeJsonRpcLine,
  encodeJsonRpcError,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeJsonRpcResult,
  jsonRpcIdKey,
  NdjsonLineReader,
  type JsonRpcId,
  type JsonRpcInbound,
} from './acpJsonRpc.js';
import {
  spawnAcpProcess,
  terminateProcessTree,
  waitForSpawn,
  type AcpProcessSpawnRequest,
  type BoundedByteTail,
  type SpawnedAcpProcess,
} from './acpProcess.js';

export { AcpConnectionError } from './acpConnectionErrors.js';

export const ACP_PROTOCOL_VERSION = 1;

export type AcpConnectionState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ready'; readonly sessionId: string }
  | { readonly kind: 'prompting'; readonly sessionId: string }
  | { readonly kind: 'closing'; readonly sessionId: string | undefined }
  | { readonly kind: 'closed'; readonly error: ProviderError | undefined };

export interface AcpHandshakeOptions {
  authMethodId: string;
  cwd: string;
  mcpServers?: unknown[];
  resumeSessionId?: string;
  clientCapabilities?: unknown;
  clientInfo?: unknown;
}

export interface AcpNotification {
  method: string;
  params: unknown;
}

export interface AcpServerRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export interface AcpConnectionOptions {
  providerInstanceId: ProviderInstanceId;
  spawn: AcpProcessSpawnRequest;
  handshake: AcpHandshakeOptions;
  onNotification?: (notification: AcpNotification) => void;
  onServerRequest?: (request: AcpServerRequest) => Promise<unknown> | unknown;
}

interface PendingRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AcpConnectionError) => void;
  settled: boolean;
}

const initializeResultSchema = z.object({ protocolVersion: z.number() }).passthrough();
const newSessionResultSchema = z.object({ sessionId: z.string().min(1) }).passthrough();
const sessionIdParamsSchema = z.object({ sessionId: z.string().min(1) }).passthrough();

export class AcpConnection {
  static async connect(options: AcpConnectionOptions): Promise<AcpConnection> {
    let spawned: SpawnedAcpProcess;
    try {
      spawned = spawnAcpProcess(options.spawn);
    } catch (error) {
      throw mapSpawnFailure(options.providerInstanceId, error);
    }

    const connection = new AcpConnection(spawned, options);
    connection.#attachStdout();
    try {
      await waitForSpawn(spawned.child);
      connection.#throwIfClosed();
      connection.#attachExit();
      await connection.#handshake(options.handshake);
      return connection;
    } catch (error) {
      await connection.close(ShutdownDeadline.fromDurationMs(0));
      if (error instanceof AcpConnectionError) {
        throw error;
      }
      throw mapSpawnFailure(options.providerInstanceId, error);
    }
  }

  #state: AcpConnectionState = { kind: 'connecting' };
  #failure: AcpConnectionError | undefined;
  #sessionSetupResult: unknown = {};
  #pendingSessionId: string | undefined;
  #nextRequestId = 1;
  #promptTail: Promise<unknown> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #reader = new NdjsonLineReader();
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stderrTail: BoundedByteTail;
  readonly #providerInstanceId: ProviderInstanceId;
  readonly #onNotification?: (notification: AcpNotification) => void;
  readonly #onServerRequest?: (request: AcpServerRequest) => Promise<unknown> | unknown;

  private constructor(spawned: SpawnedAcpProcess, options: AcpConnectionOptions) {
    this.#child = spawned.child;
    this.#stderrTail = spawned.stderrTail;
    this.#providerInstanceId = options.providerInstanceId;
    this.#onNotification = options.onNotification;
    this.#onServerRequest = options.onServerRequest;
  }

  get state(): AcpConnectionState {
    return this.#state;
  }

  get sessionId(): string {
    const sessionId = this.#currentSessionId();
    if (sessionId === undefined) {
      throw this.#error('stale_provider_operation', 'ACP connection has no session');
    }
    return sessionId;
  }

  get stderrTail(): Buffer {
    return this.#stderrTail.snapshot();
  }

  get sessionSetupResult(): unknown {
    return this.#sessionSetupResult;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return this.#request(method, params);
  }

  notify(method: string, params?: unknown): void {
    if (this.#state.kind === 'closed' || this.#state.kind === 'closing') {
      return;
    }
    this.#write(encodeJsonRpcNotification(method, params));
  }

  prompt(blocks: readonly unknown[]): Promise<unknown> {
    const run = this.#promptTail.then(() => this.#promptNow(blocks));
    this.#promptTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  cancel(): void {
    const sessionId = this.#currentSessionId();
    if (sessionId === undefined) {
      return;
    }
    this.notify('session/cancel', { sessionId });
  }

  close(deadline: ShutdownDeadline): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closePromise = this.#runClose(deadline);
    return this.#closePromise;
  }

  async #handshake(handshake: AcpHandshakeOptions): Promise<void> {
    const initializeResult = await this.#request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: handshake.clientCapabilities ?? {},
      ...(handshake.clientInfo === undefined ? {} : { clientInfo: handshake.clientInfo }),
    });
    const initialized = initializeResultSchema.safeParse(initializeResult);
    if (!initialized.success || initialized.data.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw this.#protocolError('ACP peer protocol version is incompatible');
    }

    await this.#request('authenticate', { methodId: handshake.authMethodId });

    const mcpServers = handshake.mcpServers ?? [];
    this.#pendingSessionId = handshake.resumeSessionId;
    if (handshake.resumeSessionId) {
      this.#sessionSetupResult = await this.#request('session/load', {
        sessionId: handshake.resumeSessionId,
        cwd: handshake.cwd,
        mcpServers,
      });
      this.#state = { kind: 'ready', sessionId: handshake.resumeSessionId };
      return;
    }

    const created = await this.#request('session/new', { cwd: handshake.cwd, mcpServers });
    const parsed = newSessionResultSchema.safeParse(created);
    if (!parsed.success) {
      throw this.#protocolError('ACP peer did not return a session');
    }
    this.#sessionSetupResult = created;
    this.#state = { kind: 'ready', sessionId: parsed.data.sessionId };
  }

  async #promptNow(blocks: readonly unknown[]): Promise<unknown> {
    this.#throwIfClosed();
    const sessionId = this.sessionId;
    this.#state = { kind: 'prompting', sessionId };
    try {
      return await this.#request('session/prompt', { sessionId, prompt: blocks });
    } finally {
      if (this.#state.kind === 'prompting') {
        this.#state = { kind: 'ready', sessionId };
      }
    }
  }

  #request(method: string, params?: unknown): Promise<unknown> {
    try {
      this.#throwIfClosed();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(jsonRpcIdKey(id), { id, method, resolve, reject, settled: false });
    });
    try {
      this.#write(encodeJsonRpcRequest(id, method, params));
    } catch (error) {
      const failure = error instanceof AcpConnectionError ? error : this.#staleError();
      this.#settleOne(id, { ok: false, error: failure });
    }
    return promise;
  }

  #attachStdout(): void {
    this.#child.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    this.#child.stdout.on('end', () => this.#onStdoutEnded());
    this.#child.stdout.on('error', () => undefined);
    this.#child.stdin.on('error', () => undefined);
  }

  #attachExit(): void {
    this.#child.on('exit', (code, signal) => {
      if (!this.#isInactive()) this.#fail(this.#exitedError(code, signal));
    });
    this.#child.on('error', () => {
      if (!this.#isInactive()) this.#fail(this.#exitedError(null, null));
    });
  }

  #onStdout(chunk: Buffer): void {
    const framed = this.#reader.push(chunk);
    if (framed.kind !== 'lines') {
      this.#fail(
        this.#error(
          'incompatible_provider_protocol',
          framed.kind === 'oversized'
            ? 'ACP peer exceeded the maximum inbound line size'
            : 'ACP peer sent invalid UTF-8',
        ),
      );
      this.#child.stdout.destroy();
      return;
    }
    for (const line of framed.lines) {
      if (line.length > 0) this.#onLine(line);
    }
  }

  #onStdoutEnded(): void {
    if (this.#isInactive()) return;
    this.#fail(this.#exitedError(this.#child.exitCode, this.#child.signalCode));
  }

  #onLine(line: string): void {
    const decoded = decodeJsonRpcLine(line);
    if (!decoded.ok) {
      this.#fail(this.#protocolError('ACP peer sent an invalid protocol message'));
      return;
    }
    this.#dispatch(decoded.message);
  }

  #dispatch(message: JsonRpcInbound): void {
    switch (message.kind) {
      case 'success':
        this.#settleOne(message.id, { ok: true, value: message.result });
        return;
      case 'error': {
        if (message.id === null) {
          this.#fail(this.#protocolError('ACP peer sent an invalid protocol message'));
          return;
        }
        const pending = this.#pending.get(jsonRpcIdKey(message.id));
        const rpcCode = message.error.code;
        const error =
          pending?.method === 'authenticate'
            ? this.#error('unauthenticated_provider', 'ACP authentication failed')
            : rpcCode === -32003
              ? this.#error(
                  'unavailable_provider_instance',
                  'ACP request was rate limited',
                  rpcCode,
                )
              : this.#protocolError('ACP request failed');
        this.#settleOne(message.id, { ok: false, error });
        return;
      }
      case 'notification':
        this.#dispatchNotification(message.method, message.params);
        return;
      case 'request':
        void this.#answerServerRequest(message.id, message.method, message.params);
        return;
    }
  }

  #dispatchNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      const sessionId = readSessionId(params);
      const current = this.#currentSessionId();
      // One connection projects one root ACP session. Child-session updates need
      // explicit lineage routing and must never be flattened into the parent stream.
      if (current === undefined || sessionId !== current) {
        return;
      }
    }
    try {
      this.#onNotification?.({ method, params });
    } catch {
      return;
    }
  }

  async #answerServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.#onServerRequest;
    if (!handler) {
      this.#writeQuiet(encodeJsonRpcError(id, -32601, 'Method not found'));
      return;
    }
    try {
      const result = await handler({ id, method, params });
      this.#writeQuiet(encodeJsonRpcResult(id, result ?? {}));
    } catch {
      this.#writeQuiet(encodeJsonRpcError(id, -32603, 'Internal error'));
    }
  }

  #settleOne(
    id: JsonRpcId,
    outcome: { ok: true; value: unknown } | { ok: false; error: AcpConnectionError },
  ): void {
    const pending = this.#pending.get(jsonRpcIdKey(id));
    if (!pending || pending.settled) {
      return;
    }
    pending.settled = true;
    this.#pending.delete(jsonRpcIdKey(id));
    if (outcome.ok) {
      pending.resolve(outcome.value);
    } else {
      pending.reject(outcome.error);
    }
  }

  #settleAll(error: AcpConnectionError): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const item of pending) {
      if (item.settled) {
        continue;
      }
      item.settled = true;
      item.reject(error);
    }
  }

  #fail(error: AcpConnectionError): void {
    if (this.#state.kind === 'closed') {
      this.#settleAll(error);
      return;
    }
    this.#failure = error;
    this.#state = { kind: 'closed', error: error.toProviderError() };
    this.#settleAll(error);
    this.#closePromise ??= this.#runClose(ShutdownDeadline.fromDurationMs(0));
  }

  async #runClose(deadline: ShutdownDeadline): Promise<void> {
    const sessionId = this.#currentSessionId();
    if (this.#state.kind !== 'closed') {
      this.#state = { kind: 'closing', sessionId };
    }
    this.#settleAll(this.#failure ?? this.#staleError());
    try {
      this.#child.stdin.end();
    } catch {
      // stdin may already be destroyed
    }
    await terminateProcessTree(this.#child, deadline);
    this.#child.stdout.removeAllListeners('data');
    this.#child.stdout.removeAllListeners('end');
    this.#child.stderr.removeAllListeners('data');
    this.#child.removeAllListeners('exit');
    this.#child.removeAllListeners('error');
    if (this.#state.kind !== 'closed') {
      this.#state = { kind: 'closed', error: this.#failure?.toProviderError() };
    }
  }

  #write(payload: string): void {
    if (this.#child.stdin.destroyed || !this.#child.stdin.writable) {
      throw this.#staleError();
    }
    this.#child.stdin.write(payload);
  }

  #writeQuiet(payload: string): void {
    try {
      this.#write(payload);
    } catch {
      return;
    }
  }

  #currentSessionId(): string | undefined {
    switch (this.#state.kind) {
      case 'ready':
      case 'prompting':
        return this.#state.sessionId;
      case 'closing':
        return this.#state.sessionId;
      case 'connecting':
        return this.#pendingSessionId;
      default:
        return undefined;
    }
  }

  #throwIfClosed(): void {
    if (this.#state.kind === 'closed' || this.#state.kind === 'closing') {
      throw this.#closedError();
    }
  }

  #closedError(): AcpConnectionError {
    if (this.#failure) {
      return this.#failure;
    }
    if (this.#state.kind === 'closed' && this.#state.error) {
      return new AcpConnectionError(this.#state.error);
    }
    return this.#staleError();
  }

  #staleError(): AcpConnectionError {
    return this.#error('stale_provider_operation', 'ACP operation did not complete');
  }

  #exitedError(code: number | null, signal: NodeJS.Signals | null): AcpConnectionError {
    const detail = code !== null ? String(code) : (signal ?? 'unknown');
    return this.#error('provider_process_exited', `ACP peer process exited (${detail})`);
  }

  #isInactive(): boolean {
    return this.#state.kind === 'closing' || this.#state.kind === 'closed';
  }

  #protocolError(message: string): AcpConnectionError {
    return this.#error('incompatible_provider_protocol', message);
  }

  #error(code: ProviderErrorCode, message: string, rpcCode?: number): AcpConnectionError {
    return createAcpConnectionError(this.#providerInstanceId, code, message, rpcCode);
  }
}

function readSessionId(params: unknown): string | undefined {
  const parsed = sessionIdParamsSchema.safeParse(params);
  return parsed.success ? parsed.data.sessionId : undefined;
}
