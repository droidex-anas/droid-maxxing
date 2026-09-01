import { getBridgeInfo } from './desktop';
import { noteBridgeEventReceived } from './rendererPerf';
import { setTransportHealth } from './runtimeHealth';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeResetMessage,
  type BridgeSnapshotMessage,
  type ClientCommand,
  type ServerEvent,
  type ServerEventBatch,
} from '../types/bridge';
import { serverWireMessage } from './bridgeWireValidation';

type Listener = (event: ServerEvent) => void;
type BatchListener = (events: readonly ServerEvent[]) => void;
type ReconnectScheduler = (callback: () => void, delayMs: number) => void;

interface TurnBaselineAdopter {
  gitAdoptTurnBaseline: (dir: string, clientRef: string, appSessionId: string) => Promise<unknown>;
}

function canAdoptTurnBaseline(api: object): api is TurnBaselineAdopter {
  return 'gitAdoptTurnBaseline' in api && typeof api.gitAdoptTurnBaseline === 'function';
}

export class Bridge {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly batchListeners = new Set<BatchListener>();
  private queue: ClientCommand[] = [];
  private backoff = 500;
  private url = '';
  private started = false;
  private lastGeneration: string | null = null;
  private lastSeq = 0;

  constructor(
    private readonly loadBridgeInfo = getBridgeInfo,
    private readonly schedule: ReconnectScheduler = (callback, delayMs) => {
      setTimeout(callback, delayMs);
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.connect();
  }

  private async connect(): Promise<void> {
    let port: number;
    let token: string;
    try {
      ({ port, token } = await this.loadBridgeInfo());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.url = `ws://127.0.0.1:${String(port)}${token ? `?token=${token}` : ''}`;
    this.open();
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.connectionUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoff = 500;
      setTransportHealth('connected');
      const pending = this.queue;
      this.queue = [];
      pending.forEach((command) => {
        ws.send(JSON.stringify(command));
      });
    };
    ws.onmessage = (message) => {
      if (this.ws !== ws || typeof message.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      const wireMessage = serverWireMessage(parsed);
      if (wireMessage === null) {
        if (isRecord(parsed) && parsed.type === 'events.batch') {
          this.handleMalformedBatch(ws);
        }
        return;
      }
      if (wireMessage.type === 'events.batch') {
        this.receiveBatch(wireMessage);
        return;
      }
      if (wireMessage.type === 'bridge.reset') {
        this.receiveReset(wireMessage);
        return;
      }
      if (wireMessage.type === 'bridge.snapshot') {
        this.receiveSnapshot(wireMessage);
        return;
      }
      this.publishEvents([wireMessage]);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      setTransportHealth('disconnected');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws === ws) ws.close();
    };
  }

  private receiveBatch(batch: ServerEventBatch): void {
    if (this.lastGeneration !== null && this.lastGeneration !== batch.generation) {
      this.lastGeneration = batch.generation;
      this.lastSeq = 0;
    }
    this.lastGeneration ??= batch.generation;
    if (batch.lastSeq <= this.lastSeq) return;
    if (batch.firstSeq > this.lastSeq + 1 && this.lastSeq !== 0) {
      this.ws?.close(1012, 'bridge event sequence gap');
      return;
    }

    const events = batch.events
      .filter((entry) => entry.seq > this.lastSeq)
      .map((entry) => entry.event);
    if (events.length === 0) {
      this.lastSeq = batch.lastSeq;
      return;
    }
    this.publishEvents(events);
    this.lastGeneration = batch.generation;
    this.lastSeq = batch.lastSeq;
  }

  private receiveReset(message: BridgeResetMessage): void {
    this.lastGeneration = message.generation;
    this.lastSeq = message.lastSeq;
    this.publishEvents([
      {
        type: 'error',
        code: 'bridge.resync_required',
        message: 'The renderer sent an invalid event resume cursor and started a fresh stream.',
        recoverable: false,
      },
    ]);
  }

  private receiveSnapshot(message: BridgeSnapshotMessage): void {
    this.lastGeneration = message.generation;
    this.lastSeq = message.lastSeq;
    this.publishEvents(eventsFromSnapshot(message));
  }

  private handleMalformedBatch(ws: WebSocket): void {
    this.lastGeneration = null;
    this.lastSeq = 0;
    this.publishEvents([
      {
        type: 'error',
        code: 'bridge.resync_required',
        message:
          'The agent runtime sent a malformed event batch. Reconnecting with a fresh cursor.',
        recoverable: true,
      },
    ]);
    ws.close(1002, 'malformed bridge message');
  }

  private publishEvents(events: readonly ServerEvent[]): void {
    for (const event of events) {
      noteBridgeEventReceived(event);
      this.adoptTurnBaseline(event);
      for (const listener of this.listeners) listener(event);
    }
    for (const listener of this.batchListeners) listener(events);
  }

  private adoptTurnBaseline(event: ServerEvent): void {
    if (event.type !== 'session.created' || !event.session.cwd) return;
    const api = globalThis.window.droidControl;
    if (!api || !canAdoptTurnBaseline(api)) return;
    void api
      .gitAdoptTurnBaseline(event.session.cwd, event.clientRef, event.session.appSessionId)
      .catch(() => {
        // Best effort: Review falls back to HEAD when no baseline exists.
      });
  }

  private connectionUrl(): string {
    const params = new URLSearchParams({
      bridgeProtocol: String(BRIDGE_PROTOCOL_VERSION),
    });
    if (this.lastGeneration !== null) {
      params.set('resumeGeneration', this.lastGeneration);
      params.set('resumeSeq', String(this.lastSeq));
    }
    return `${this.url}${this.url.includes('?') ? '&' : '?'}${params.toString()}`;
  }

  private scheduleReconnect(): void {
    this.schedule(() => void this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5_000);
  }

  send(command: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(command));
    else this.queue.push(command);
  }

  sendIfConnected(command: ClientCommand): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(command));
    return true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeBatch(listener: BatchListener): () => void {
    this.batchListeners.add(listener);
    return () => this.batchListeners.delete(listener);
  }
}

function eventsFromSnapshot(message: BridgeSnapshotMessage): ServerEvent[] {
  const events: ServerEvent[] = [
    {
      type: 'runtime.updated',
      status: message.snapshot.runtime,
    },
  ];
  for (const session of message.snapshot.sessions) {
    events.push({ type: 'session.updated', session });
  }
  for (const child of message.snapshot.children) {
    events.push({
      type: 'session.child',
      event: 'upserted',
      child,
      runtimeAvailable: false,
      runtimeGeneration: 0,
    });
  }
  for (const interrupted of message.snapshot.interrupted) {
    events.push({
      type: 'error',
      code: 'session.interrupted',
      appSessionId: interrupted.appSessionId,
      message: interrupted.reason,
      recoverable: true,
    });
  }
  if (message.snapshot.persistence.hadUnflushedWork) {
    events.push({
      type: 'error',
      code: 'history.unflushed_work',
      message:
        message.snapshot.persistence.message ??
        'The previous agent runtime exited with unflushed history. Restored sessions use the last durable snapshot.',
      recoverable: true,
    });
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const bridge = new Bridge();
