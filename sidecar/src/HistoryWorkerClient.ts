import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
  type MessagePort,
  type WorkerOptions,
} from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

import type {
  HistoryPersistenceBatch,
  HistoryPersistenceResult,
  HistoryWorkerEnvelope,
  HistoryWorkerRequest,
  HistoryWorkerResponse,
  HistoryWorkerValue,
  HistoryWriterLease,
} from './historyPersistenceProtocol.js';
import { historyWorkerError } from './historyPersistenceProtocol.js';
import type {
  SessionFileChange,
  SessionFileReconciliation,
  SessionFileSnapshot,
} from './sessionFileCache.js';
import type { SessionSearchResult } from './protocol.js';

const SYNC_WAIT_SLICE_MS = 5;
const DEFAULT_SYNC_TIMEOUT_MS = 10_000;
const SEARCH_TRANSPORT_TIMEOUT_MS = 60_000;
const sleepSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface HistoryPersistenceCall<T> {
  readonly promise: Promise<T>;
  waitSync(timeoutMs?: number): T;
}

export interface HistoryPersistenceClient {
  startPersist(batch: HistoryPersistenceBatch): HistoryPersistenceCall<HistoryPersistenceResult>;
  startDurabilityBarrier(): HistoryPersistenceCall<{ durable: true }>;
  closeSync(): void;
}

export interface HistorySearchClient {
  reconcileSessionFiles(): Promise<SessionFileReconciliation>;
  reconcileSessionFilePaths(changes: SessionFileChange[]): Promise<SessionFileReconciliation>;
  sessionFileSnapshot(): Promise<SessionFileSnapshot>;
  setIndexingIdle(isIdle: boolean): Promise<void>;
  search(query: string): Promise<SessionSearchResult[]>;
  closeSync(): void;
}

export interface HistoryWorkerClientOptions {
  worker?: Worker;
  workerUrl?: URL;
  workerData?: unknown;
  workerFactory?: () => Worker;
  syncTimeoutMs?: number;
  scheduleWatchdog?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelWatchdog?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class HistoryWorkerClient implements HistoryPersistenceClient, HistorySearchClient {
  private worker: Worker;
  private readonly createWorker: () => Worker;
  private readonly syncTimeoutMs: number;
  private readonly scheduleWatchdog: NonNullable<HistoryWorkerClientOptions['scheduleWatchdog']>;
  private readonly cancelWatchdog: NonNullable<HistoryWorkerClientOptions['cancelWatchdog']>;
  private readonly activeCalls = new Set<{ failExternal(error: Error): void }>();
  private readonly writerOwner = randomUUID();
  private writerGeneration = 1;
  private failed: Error | null = null;
  private closed = false;

  constructor(options: HistoryWorkerClientOptions = {}) {
    this.syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.scheduleWatchdog = options.scheduleWatchdog ?? scheduleTimeout;
    this.cancelWatchdog = options.cancelWatchdog ?? clearTimeout;
    const workerOptions: WorkerOptions = {
      workerData: options.workerData,
      execArgv: [],
    };
    this.createWorker =
      options.workerFactory ??
      (() => new Worker(options.workerUrl ?? defaultWorkerUrl(), workerOptions));
    this.worker = options.worker ?? this.createWorker();
    this.observeWorker(this.worker);
  }

  startPersist(batch: HistoryPersistenceBatch): HistoryPersistenceCall<HistoryPersistenceResult> {
    return this.call<HistoryPersistenceResult>({ type: 'persist', batch });
  }

  startDurabilityBarrier(): HistoryPersistenceCall<{ durable: true }> {
    return this.call<{ durable: true }>({ type: 'durability-barrier' });
  }

  async reconcileSessionFiles(): Promise<SessionFileReconciliation> {
    return await this.call<SessionFileReconciliation>({ type: 'reconcile-files' }).promise;
  }

  async reconcileSessionFilePaths(
    changes: SessionFileChange[],
  ): Promise<SessionFileReconciliation> {
    return await this.call<SessionFileReconciliation>({
      type: 'reconcile-file-paths',
      changes,
    }).promise;
  }

  async sessionFileSnapshot(): Promise<SessionFileSnapshot> {
    return await this.call<SessionFileSnapshot>({ type: 'session-file-snapshot' }).promise;
  }

  async setIndexingIdle(isIdle: boolean): Promise<void> {
    await this.call<{ accepted: true }>({ type: 'indexing-idle', isIdle }).promise;
  }

  async search(query: string): Promise<SessionSearchResult[]> {
    return await this.call<SessionSearchResult[]>({ type: 'search', query }).promise;
  }

  closeSync(): void {
    if (this.closed) return;
    let closeError: Error | undefined;
    if (!this.failed) {
      try {
        this.call<{ closed: true }>({ type: 'close' }).waitSync(this.syncTimeoutMs);
      } catch (error) {
        closeError = asError(error);
      }
    }
    this.closed = true;
    void this.worker.terminate();
    const terminal = this.failed ?? new Error('History persistence worker is closed.');
    for (const call of this.activeCalls) call.failExternal(terminal);
    this.activeCalls.clear();
    if (closeError) throw closeError;
  }

  private call<T extends HistoryWorkerValue>(request: HistoryWorkerRequest): PortWorkerCall<T> {
    if (this.closed) throw new Error('History persistence worker is closed.');
    this.restartFailedWorker();
    const channel = new MessageChannel();
    const call = new PortWorkerCall<T>(
      channel.port1,
      () => {
        this.activeCalls.delete(call);
      },
      (error) => {
        if (isSearchLaneRequest(request)) call.failExternal(error);
        else this.fail(error);
      },
    );
    this.activeCalls.add(call);
    const envelope: HistoryWorkerEnvelope = {
      request,
      replyPort: channel.port2,
      ...(isPersistenceRequest(request) ? { writerLease: this.writerLease() } : {}),
    };
    try {
      this.worker.postMessage(envelope, [channel.port2]);
    } catch (error) {
      const failure = asError(error);
      void call.promise.catch(() => undefined);
      call.failExternal(failure);
      channel.port2.close();
      this.fail(failure);
      throw failure;
    }
    call.startTransportWatchdog(
      isSearchLaneRequest(request) ? SEARCH_TRANSPORT_TIMEOUT_MS : this.syncTimeoutMs,
      this.scheduleWatchdog,
      this.cancelWatchdog,
    );
    return call;
  }

  private observeWorker(worker: Worker): void {
    worker.on('error', (error) => {
      if (this.worker === worker) this.fail(asError(error));
    });
    worker.on('exit', (code) => {
      if (!this.closed && this.worker === worker) {
        this.fail(new Error(`History persistence worker exited with code ${String(code)}.`));
      }
    });
  }

  private restartFailedWorker(): void {
    if (!this.failed) return;
    void this.worker.terminate();
    this.writerGeneration += 1;
    this.worker = this.createWorker();
    this.failed = null;
    this.observeWorker(this.worker);
  }

  private fail(error: Error): void {
    this.failed ??= error;
    for (const call of this.activeCalls) call.failExternal(this.failed);
    this.activeCalls.clear();
  }

  private writerLease(): HistoryWriterLease {
    return { owner: this.writerOwner, generation: this.writerGeneration, processId: process.pid };
  }
}

function isPersistenceRequest(request: HistoryWorkerRequest): boolean {
  return request.type === 'persist' || request.type === 'durability-barrier';
}

function isSearchLaneRequest(request: HistoryWorkerRequest): boolean {
  return (
    request.type === 'reconcile-files' ||
    request.type === 'reconcile-file-paths' ||
    request.type === 'session-file-snapshot' ||
    request.type === 'indexing-idle' ||
    request.type === 'search'
  );
}

class PortWorkerCall<T extends HistoryWorkerValue> implements HistoryPersistenceCall<T> {
  readonly promise: Promise<T>;
  private settled = false;
  private value: T | undefined;
  private error: Error | undefined;
  private resolvePromise: ((value: T) => void) | undefined;
  private rejectPromise: ((error: Error) => void) | undefined;
  private transportWatchdog: ReturnType<typeof setTimeout> | undefined;
  private cancelTransportWatchdog: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;

  constructor(
    private readonly port: MessagePort,
    private readonly onSettled: () => void,
    private readonly onTransportFailure: (error: Error) => void,
  ) {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    port.on('message', (response: HistoryWorkerResponse) => {
      this.settle(response);
    });
    port.on('messageerror', () => {
      this.failTransport(new Error('History persistence worker returned an invalid message.'));
    });
    port.start();
  }

  waitSync(timeoutMs = DEFAULT_SYNC_TIMEOUT_MS): T {
    // A synchronous caller observes the same failure by throwing below. Mark
    // the promise branch handled so a timeout or worker exit is not also
    // reported as an unhandled rejection on the next event-loop turn.
    void this.promise.catch(() => undefined);
    const deadline = performance.now() + timeoutMs;
    while (!this.settled) {
      const received = receiveMessageOnPort(this.port);
      if (received) {
        this.settle(received.message as HistoryWorkerResponse);
        break;
      }
      if (performance.now() >= deadline) {
        this.failTransport(
          new Error(`History persistence worker did not respond within ${String(timeoutMs)}ms.`),
        );
        break;
      }
      Atomics.wait(sleepSignal, 0, 0, SYNC_WAIT_SLICE_MS);
    }
    if (this.error) throw this.error;
    if (this.value === undefined) throw new Error('History persistence worker returned no value.');
    return this.value;
  }

  startTransportWatchdog(
    timeoutMs: number,
    schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>,
    cancel: (timer: ReturnType<typeof setTimeout>) => void,
  ): void {
    if (this.settled) return;
    this.cancelTransportWatchdog = cancel;
    this.transportWatchdog = schedule(() => {
      this.failTransport(
        new Error(`History persistence worker did not respond within ${String(timeoutMs)}ms.`),
      );
    }, timeoutMs);
  }

  failExternal(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.error = error;
    this.rejectPromise?.(error);
    this.dispose();
  }

  private failTransport(error: Error): void {
    if (this.settled) return;
    this.onTransportFailure(error);
  }

  private settle(response: HistoryWorkerResponse): void {
    if (this.settled) return;
    if (response.ok) {
      this.settled = true;
      this.value = response.value as T;
      this.resolvePromise?.(this.value);
      this.dispose();
      return;
    }
    this.failExternal(historyWorkerError(response.error));
  }

  private dispose(): void {
    if (this.transportWatchdog) {
      this.cancelTransportWatchdog?.(this.transportWatchdog);
      this.transportWatchdog = undefined;
      this.cancelTransportWatchdog = undefined;
    }
    this.resolvePromise = undefined;
    this.rejectPromise = undefined;
    this.port.removeAllListeners();
    this.port.close();
    this.onSettled();
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return timer;
}

function defaultWorkerUrl(): URL {
  const source = import.meta.url.endsWith('.ts');
  return new URL(
    source ? './historyPersistenceWorkerLoader.mjs' : './historyPersistenceWorker.mjs',
    import.meta.url,
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
