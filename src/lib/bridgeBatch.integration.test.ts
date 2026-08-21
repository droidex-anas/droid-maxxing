import assert from 'node:assert/strict';
import test from 'node:test';

import { Bridge } from './bridge';
import type { ServerEvent, ServerEventBatch } from '../types/bridge';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closeArgs: [number | undefined, string | undefined] | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }

  close(code?: number, reason?: string): void {
    this.closeArgs = [code, reason];
    this.readyState = 3;
    this.onclose?.();
  }
}

function batch(
  generation: string,
  firstSeq: number,
  lastSeq: number,
  events: ServerEvent[],
): ServerEventBatch {
  return {
    type: 'events.batch',
    generation,
    firstSeq,
    lastSeq,
    events: events.map((event, index) => ({ seq: firstSeq + index, event })),
  };
}

function installFakeRuntime(): {
  oldWindow: Window & typeof globalThis;
  OldWebSocket: typeof WebSocket;
} {
  const oldWindow = globalThis.window;
  const OldWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  Object.assign(globalThis, {
    window: { droidControl: {} },
    WebSocket: FakeWebSocket,
  });
  return { oldWindow, OldWebSocket };
}

function restoreFakeRuntime(runtime: {
  oldWindow: Window & typeof globalThis;
  OldWebSocket: typeof WebSocket;
}): void {
  Object.assign(globalThis, {
    window: runtime.oldWindow,
    WebSocket: runtime.OldWebSocket,
  });
}

test(
  'bridge publishes one server batch while preserving per-event subscribers',
  { concurrency: false },
  async () => {
    const runtime = installFakeRuntime();
    try {
      const bridge = new Bridge(
        async () => ({ port: 43120, token: 'batch-token' }),
        () => undefined,
      );
      const events: string[] = [];
      const batches: string[][] = [];
      bridge.subscribe((event) => events.push(event.type));
      bridge.subscribeBatch((eventsInBatch) =>
        batches.push(eventsInBatch.map((event) => event.type)),
      );
      await bridge.start();
      const socket = required(FakeWebSocket.instances.at(-1));
      socket.open();
      socket.message(
        batch('generation-1', 1, 2, [
          { type: 'connection', status: 'connected' },
          {
            type: 'runtime.updated',
            status: {
              mode: 'cli_auth',
              droidPath: '/bin/droid',
              apiKeyConfigured: false,
            },
          },
        ]),
      );

      assert.deepEqual(events, ['connection', 'runtime.updated']);
      assert.deepEqual(batches, [['connection', 'runtime.updated']]);
    } finally {
      restoreFakeRuntime(runtime);
    }
  },
);

test(
  'bridge accepts legacy direct events during a mixed-version update',
  { concurrency: false },
  async () => {
    const runtime = installFakeRuntime();
    try {
      const bridge = new Bridge(
        async () => ({ port: 43121, token: 'legacy-token' }),
        () => undefined,
      );
      const batches: string[][] = [];
      bridge.subscribeBatch((events) => batches.push(events.map((event) => event.type)));
      await bridge.start();
      const socket = required(FakeWebSocket.instances.at(-1));
      socket.open();
      socket.message({ type: 'connection', status: 'connected' });
      assert.deepEqual(batches, [['connection']]);
    } finally {
      restoreFakeRuntime(runtime);
    }
  },
);

test(
  'reconnect carries the last fully applied generation and sequence',
  { concurrency: false },
  async () => {
    const runtime = installFakeRuntime();
    const reconnects: Array<() => void> = [];
    try {
      const bridge = new Bridge(
        async () => ({ port: 43122, token: 'resume-token' }),
        (callback) => reconnects.push(callback),
      );
      await bridge.start();
      const first = required(FakeWebSocket.instances.at(-1));
      first.open();
      first.message(batch('generation-1', 1, 1, [{ type: 'connection', status: 'connected' }]));
      first.close();

      reconnects.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      const second = required(FakeWebSocket.instances.at(-1));
      const url = new URL(second.url);
      assert.equal(url.searchParams.get('bridgeProtocol'), '2');
      assert.equal(url.searchParams.get('resumeGeneration'), 'generation-1');
      assert.equal(url.searchParams.get('resumeSeq'), '1');
    } finally {
      restoreFakeRuntime(runtime);
    }
  },
);

test(
  'coalesced sequence gaps inside one batch advance the resume cursor safely',
  { concurrency: false },
  async () => {
    const runtime = installFakeRuntime();
    const reconnects: Array<() => void> = [];
    try {
      const bridge = new Bridge(
        async () => ({ port: 43127, token: 'coalesced-token' }),
        (callback) => reconnects.push(callback),
      );
      const seen: string[] = [];
      bridge.subscribe((event) => seen.push(event.type));
      await bridge.start();
      const first = required(FakeWebSocket.instances.at(-1));
      first.open();
      first.message({
        type: 'events.batch',
        generation: 'generation-1',
        firstSeq: 1,
        lastSeq: 3,
        events: [{ seq: 3, event: { type: 'connection', status: 'connected' } }],
      });

      assert.deepEqual(seen, ['connection']);
      assert.equal(first.closeArgs, null);
      first.close();
      reconnects.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      const second = required(FakeWebSocket.instances.at(-1));
      const url = new URL(second.url);
      assert.equal(url.searchParams.get('resumeGeneration'), 'generation-1');
      assert.equal(url.searchParams.get('resumeSeq'), '3');
    } finally {
      restoreFakeRuntime(runtime);
    }
  },
);

test(
  'bridge reset advances the resume cursor and emits one recoverable diagnostic',
  { concurrency: false },
  async () => {
    const runtime = installFakeRuntime();
    const reconnects: Array<() => void> = [];
    try {
      const bridge = new Bridge(
        async () => ({ port: 43125, token: 'reset-token' }),
        (callback) => reconnects.push(callback),
      );
      const seen: ServerEvent[] = [];
      bridge.subscribe((event) => seen.push(event));
      await bridge.start();
      const first = required(FakeWebSocket.instances.at(-1));
      first.open();
      first.message({
        type: 'bridge.reset',
        generation: 'generation-2',
        lastSeq: 42,
        reason: 'generation_changed',
      });

      assert.deepEqual(seen, [
        {
          type: 'error',
          code: 'bridge.resync_required',
          message:
            'The agent runtime restarted. Reopen the active session if its live state does not refresh.',
          recoverable: true,
        },
      ]);

      first.close();
      reconnects.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      const second = required(FakeWebSocket.instances.at(-1));
      const url = new URL(second.url);
      assert.equal(url.searchParams.get('resumeGeneration'), 'generation-2');
      assert.equal(url.searchParams.get('resumeSeq'), '42');
    } finally {
      restoreFakeRuntime(runtime);
    }
  },
);

test('late messages from a replaced socket are ignored', { concurrency: false }, async () => {
  const runtime = installFakeRuntime();
  const reconnects: Array<() => void> = [];
  try {
    const bridge = new Bridge(
      async () => ({ port: 43126, token: 'stale-token' }),
      (callback) => reconnects.push(callback),
    );
    const seen: string[] = [];
    bridge.subscribe((event) => seen.push(event.type));
    await bridge.start();
    const first = required(FakeWebSocket.instances.at(-1));
    first.open();
    first.close();

    reconnects.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    const second = required(FakeWebSocket.instances.at(-1));
    second.open();

    first.message({ type: 'connection', status: 'connected' });
    second.message({ type: 'connection', status: 'connected' });
    assert.deepEqual(seen, ['connection']);
  } finally {
    restoreFakeRuntime(runtime);
  }
});

test(
  'duplicate replay batches are ignored and sequence gaps reconnect',
  { concurrency: false },
  async () => {
    const runtime = installFakeRuntime();
    try {
      const bridge = new Bridge(
        async () => ({ port: 43124, token: 'sequence-token' }),
        () => undefined,
      );
      const seen: string[] = [];
      bridge.subscribe((event) => seen.push(event.type));
      await bridge.start();
      const socket = required(FakeWebSocket.instances.at(-1));
      socket.open();
      const first = batch('generation-1', 1, 1, [{ type: 'connection', status: 'connected' }]);
      socket.message(first);
      socket.message(first);
      assert.deepEqual(seen, ['connection']);

      socket.message(batch('generation-1', 3, 3, [{ type: 'connection', status: 'connected' }]));
      assert.deepEqual(socket.closeArgs, [1012, 'bridge event sequence gap']);
    } finally {
      restoreFakeRuntime(runtime);
    }
  },
);

test(
  'malformed batches reset the cursor and reconnect without publishing payloads',
  { concurrency: false },
  async () => {
    const runtime = installFakeRuntime();
    const reconnects: Array<() => void> = [];
    try {
      const bridge = new Bridge(
        async () => ({ port: 43128, token: 'malformed-token' }),
        (callback) => reconnects.push(callback),
      );
      const seen: ServerEvent[] = [];
      bridge.subscribe((event) => seen.push(event));
      await bridge.start();
      const first = required(FakeWebSocket.instances.at(-1));
      first.open();
      first.message({
        type: 'events.batch',
        generation: 'generation-1',
        firstSeq: 1,
        lastSeq: 1,
        events: null,
      });

      assert.deepEqual(first.closeArgs, [1002, 'malformed bridge message']);
      assert.deepEqual(seen, [
        {
          type: 'error',
          code: 'bridge.resync_required',
          message:
            'The agent runtime sent a malformed event batch. Reconnecting with a fresh cursor.',
          recoverable: true,
        },
      ]);

      reconnects.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      const second = required(FakeWebSocket.instances.at(-1));
      const url = new URL(second.url);
      assert.equal(url.searchParams.get('resumeGeneration'), null);
      assert.equal(url.searchParams.get('resumeSeq'), null);
    } finally {
      restoreFakeRuntime(runtime);
    }
  },
);

test(
  'empty reset generations cannot replace a valid resume cursor',
  { concurrency: false },
  async () => {
    const runtime = installFakeRuntime();
    const reconnects: Array<() => void> = [];
    try {
      const bridge = new Bridge(
        async () => ({ port: 43129, token: 'reset-token' }),
        (callback) => reconnects.push(callback),
      );
      const seen: string[] = [];
      bridge.subscribe((event) => seen.push(event.type));
      await bridge.start();
      const first = required(FakeWebSocket.instances.at(-1));
      first.open();
      first.message(batch('generation-1', 1, 1, [{ type: 'connection', status: 'connected' }]));
      first.message({
        type: 'bridge.reset',
        generation: '',
        lastSeq: 1,
        reason: 'replay_unavailable',
      });

      first.close();
      reconnects.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      const second = required(FakeWebSocket.instances.at(-1));
      const url = new URL(second.url);
      assert.equal(url.searchParams.get('resumeGeneration'), 'generation-1');
      assert.equal(url.searchParams.get('resumeSeq'), '1');
      assert.deepEqual(seen, ['connection']);
    } finally {
      restoreFakeRuntime(runtime);
    }
  },
);

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected fake socket');
  return value;
}
