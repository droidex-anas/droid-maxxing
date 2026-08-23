import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
  type MessagePort,
  type WorkerOptions,
} from 'node:worker_threads';

import type {
  HistoryPersistenceBatch,
  HistoryPersistenceResult,
  HistoryWorkerEnvelope,
  HistoryWorkerRequest,
  HistoryWorkerResponse,
  HistoryWorkerValue,
} from './historyPersistenceProtocol.js';
import { historyWorkerError } from './historyPersistenceProtocol.js';
import type { SessionSearchResult } from './protocol.js';
import type { SessionSearchCandidate } from './sessionSearch.js';

const SYNC_WAIT_SLICE_MS = 5;
const DEFAULT_SYNC_TIMEOUT_MS = 10_000;
const sleepSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface HistoryPersistenceCall<T> {
  readonly promise: Promise<T>;
  waitSync(timeoutMs?: number): T;
}

export interface HistoryPersistenceClient {
  startPersist(batch: HistoryPersistenceBatch): HistoryPersistenceCall<HistoryPersistenceResult>;
  search(query: string, candidates?: SessionSearchCandidate[]): Promise<SessionSearchResult[]>;
  invalidateSearch(): void;
  closeSync(): void;
}

export interface HistoryWorkerClientOptions {
  worker?: Worker;
  workerUrl?: URL;
  workerData?: unknown;
  syncTimeoutMs?: number;
}

export class HistoryWorkerClient implements HistoryPersistenceClient {
  private readonly worker: Worker;
  private readonly syncTimeoutMs: number;
  private readonly activeCalls = new Set<{ failExternal(error: Error): void }>();
  private failed: Error | null = null;
  private closed = false;
  private searchGeneration = 0;

  constructor(options: HistoryWorkerClientOptions = {}) {
    this.syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    const workerOptions: WorkerOptions = {
      workerData: options.workerData,
      execArgv: [],
    };
    this.worker =
      options.worker ?? new Worker(options.workerUrl ?? defaultWorkerUrl(), workerOptions);
    this.worker.on('error', (error) => {
      this.fail(asError(error));
    });
    this.worker.on('exit', (code) => {
      if (!this.closed) {
        this.fail(new Error(`History persistence worker exited with code ${String(code)}.`));
      }
    });
  }

  startPersist(batch: HistoryPersistenceBatch): HistoryPersistenceCall<HistoryPersistenceResult> {
    return this.call<HistoryPersistenceResult>({ type: 'persist', batch });
  }

  async search(
    query: string,
    candidates: SessionSearchCandidate[] = [],
  ): Promise<SessionSearchResult[]> {
    const generation = ++this.searchGeneration;
    return await this.call<SessionSearchResult[]>({
      type: 'search',
      generation,
      query,
      candidates,
    }).promise;
  }

  invalidateSearch(): void {
    if (this.closed || this.failed) return;
    const generation = ++this.searchGeneration;
    const call = this.call<{ invalidated: true }>({ type: 'invalidate-search', generation });
    void call.promise.catch(() => undefined);
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
    if (this.closed || this.failed) {
      throw this.failed ?? new Error('History persistence worker is closed.');
    }
    const channel = new MessageChannel();
    const call = new PortWorkerCall<T>(channel.port1, () => {
      this.activeCalls.delete(call);
    });
    this.activeCalls.add(call);
    const envelope: HistoryWorkerEnvelope = { request, replyPort: channel.port2 };
    this.worker.postMessage(envelope, [channel.port2]);
    return call;
  }

  private fail(error: Error): void {
    this.failed ??= error;
    for (const call of this.activeCalls) call.failExternal(this.failed);
    this.activeCalls.clear();
  }
}

class PortWorkerCall<T extends HistoryWorkerValue> implements HistoryPersistenceCall<T> {
  readonly promise: Promise<T>;
  private settled = false;
  private value: T | undefined;
  private error: Error | undefined;
  private resolvePromise: ((value: T) => void) | undefined;
  private rejectPromise: ((error: Error) => void) | undefined;

  constructor(
    private readonly port: MessagePort,
    private readonly onSettled: () => void,
  ) {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    port.on('message', (response: HistoryWorkerResponse) => {
      this.settle(response);
    });
    port.on('messageerror', () => {
      this.failExternal(new Error('History persistence worker returned an invalid message.'));
    });
    port.start();
  }

  waitSync(timeoutMs = DEFAULT_SYNC_TIMEOUT_MS): T {
    const deadline = performance.now() + timeoutMs;
    while (!this.settled) {
      const received = receiveMessageOnPort(this.port);
      if (received) {
        this.settle(received.message as HistoryWorkerResponse);
        break;
      }
      if (performance.now() >= deadline) {
        this.failExternal(
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

  failExternal(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.error = error;
    this.rejectPromise?.(error);
    this.dispose();
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
    this.resolvePromise = undefined;
    this.rejectPromise = undefined;
    this.port.removeAllListeners();
    this.port.close();
    this.onSettled();
  }
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
