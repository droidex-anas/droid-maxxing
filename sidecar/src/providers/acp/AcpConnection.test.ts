import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

import { ShutdownDeadline } from '../shutdownDeadline.js';
import { ACP_STDERR_TAIL_BYTES } from './acpProcess.js';
import { ACP_MAX_INBOUND_LINE_BYTES } from './acpJsonRpc.js';
import { AcpConnection, AcpConnectionError, type AcpServerRequest } from './AcpConnection.js';
import {
  fakeAcpPeerPath,
  fakeAcpPeerSpawn,
  type FakeAcpPeerBehavior,
} from './testing/fakeAcpPeer.js';

async function connectFake(
  behavior: FakeAcpPeerBehavior = 'handshake',
  extras: {
    resumeSessionId?: string;
    onNotification?: (notification: { method: string; params: unknown }) => void;
    onServerRequest?: (request: AcpServerRequest) => Promise<unknown> | unknown;
    providerInstanceId?: 'cursor' | 'grok';
  } = {},
): Promise<AcpConnection> {
  return AcpConnection.connect({
    providerInstanceId: extras.providerInstanceId ?? 'cursor',
    spawn: fakeAcpPeerSpawn(behavior),
    handshake: {
      authMethodId: extras.providerInstanceId === 'grok' ? 'xai.api_key' : 'cursor_login',
      cwd: process.cwd(),
      ...(extras.resumeSessionId ? { resumeSessionId: extras.resumeSessionId } : {}),
    },
    onNotification: extras.onNotification,
    onServerRequest: extras.onServerRequest,
  });
}

async function closeQuiet(connection: AcpConnection): Promise<void> {
  await connection.close(ShutdownDeadline.fromDurationMs(5_000));
}

function isConnectionError(error: unknown, code: string): error is AcpConnectionError {
  return error instanceof AcpConnectionError && error.code === code;
}

test('full handshake ordering is initialize, then authenticate, then session/new', async () => {
  const connection = await connectFake('handshake');
  try {
    assert.equal(connection.state.kind, 'ready');
    assert.equal(connection.sessionId, 'mock-session-1');
    const recorded = await connection.request('x/received-methods');
    assert.deepEqual(recorded, {
      receivedMethods: ['initialize', 'authenticate', 'session/new', 'x/received-methods'],
    });
  } finally {
    await closeQuiet(connection);
  }
});

test('resume path uses session/load instead of session/new', async () => {
  const connection = await connectFake('handshake', { resumeSessionId: 'resume-1' });
  try {
    assert.equal(connection.sessionId, 'resume-1');
    const recorded = await connection.request('x/received-methods');
    assert.ok(isPlainObject(recorded));
    if (!isPlainObject(recorded) || !Array.isArray(recorded.receivedMethods)) {
      assert.fail('expected receivedMethods');
      return;
    }
    assert.deepEqual(recorded.receivedMethods.slice(0, 3), [
      'initialize',
      'authenticate',
      'session/load',
    ]);
    assert.equal(recorded.receivedMethods.includes('session/new'), false);
  } finally {
    await closeQuiet(connection);
  }
});

test('request/response correlation matches out-of-order replies', async () => {
  const connection = await connectFake('out-of-order');
  try {
    const first = connection.request('x/first', { n: 1 });
    const second = connection.request('x/second', { n: 2 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, { echoedMethod: 'x/first', echoedParams: { n: 1 } });
    assert.deepEqual(secondResult, { echoedMethod: 'x/second', echoedParams: { n: 2 } });
  } finally {
    await closeQuiet(connection);
  }
});

test('numeric id 0 on a server-initiated request is echoed back as number 0', async () => {
  let seen: AcpServerRequest | undefined;
  const connection = await connectFake('server-request-zero-id', {
    onServerRequest: (request) => {
      seen = request;
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    },
  });
  try {
    const result = await connection.prompt([{ type: 'text', text: 'hi' }]);
    assert.equal(seen?.id, 0);
    assert.equal(typeof seen?.id, 'number');
    assert.equal(Boolean(seen?.id), false);
    assert.ok(isPlainObject(result));
    if (!isPlainObject(result)) return;
    assert.equal(result.echoedId, 0);
    assert.equal(result.echoedIdType, 'number');
    assert.equal(result.matched, true);
  } finally {
    await closeQuiet(connection);
  }
});

test('a string server-request id is echoed back as a string', async () => {
  let seen: AcpServerRequest | undefined;
  const connection = await connectFake('server-request-string-id', {
    onServerRequest: (request) => {
      seen = request;
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    },
  });
  try {
    const result = await connection.prompt([{ type: 'text', text: 'hi' }]);
    assert.equal(seen?.id, 'perm-1');
    assert.equal(typeof seen?.id, 'string');
    assert.ok(isPlainObject(result));
    if (!isPlainObject(result)) return;
    assert.equal(result.echoedId, 'perm-1');
    assert.equal(result.echoedIdType, 'string');
    assert.equal(result.matched, true);
  } finally {
    await closeQuiet(connection);
  }
});

test('notifications with no id are dispatched and never awaited', async () => {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const connection = await connectFake('unsolicited-notification', {
    onNotification: (notification) => {
      notifications.push(notification);
    },
  });
  try {
    const result = await connection.request('x/ping', { ok: true });
    assert.deepEqual(result, { echoedMethod: 'x/ping', echoedParams: { ok: true } });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.method, 'session/update');
  } finally {
    await closeQuiet(connection);
  }
});

test('session/update for a different sessionId is ignored', async () => {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const connection = await connectFake('foreign-session-update', {
    onNotification: (notification) => {
      notifications.push(notification);
    },
  });
  try {
    await connection.prompt([{ type: 'text', text: 'hi' }]);
    assert.equal(notifications.length, 1);
    assert.ok(isPlainObject(notifications[0]?.params));
    if (!isPlainObject(notifications[0]?.params)) return;
    assert.equal(notifications[0].params.sessionId, 'mock-session-1');
  } finally {
    await closeQuiet(connection);
  }
});

test('a line exceeding the maximum size fails the connection with a clear diagnostic', async () => {
  await assert.rejects(
    () => connectFake('oversized-line'),
    (error: unknown) => {
      assert.ok(isConnectionError(error, 'incompatible_provider_protocol'));
      if (!isConnectionError(error, 'incompatible_provider_protocol')) return false;
      assert.match(error.message, /maximum inbound line size/);
      assert.equal(error.message.includes('x'.repeat(32)), false);
      return true;
    },
  );
});

test('invalid UTF-8 is rejected without crashing the sidecar', async () => {
  await assert.rejects(
    () => connectFake('invalid-utf8'),
    (error: unknown) => isConnectionError(error, 'incompatible_provider_protocol'),
  );
});

test('malformed JSON is rejected without crashing the sidecar', async () => {
  await assert.rejects(
    () => connectFake('malformed-json'),
    (error: unknown) => isConnectionError(error, 'incompatible_provider_protocol'),
  );
});

test('EOF with requests in flight settles every pending request exactly once', async () => {
  const connection = await connectFake('eof-on-prompt');
  try {
    let settlements = 0;
    await assert.rejects(
      connection.prompt([{ type: 'text', text: 'hi' }]).finally(() => {
        settlements += 1;
      }),
      (error: unknown) =>
        isConnectionError(error, 'provider_process_exited') ||
        isConnectionError(error, 'stale_provider_operation'),
    );
    assert.equal(settlements, 1);
    await assert.rejects(
      connection.request('x/after-eof'),
      (error: unknown) =>
        isConnectionError(error, 'provider_process_exited') ||
        isConnectionError(error, 'stale_provider_operation'),
    );
  } finally {
    await closeQuiet(connection);
  }
});

test('child crash mid-turn settles pending requests as provider_process_exited', async () => {
  const connection = await connectFake('crash-on-prompt');
  try {
    await assert.rejects(connection.prompt([{ type: 'text', text: 'hi' }]), (error: unknown) => {
      assert.ok(isConnectionError(error, 'provider_process_exited'));
      if (!isConnectionError(error, 'provider_process_exited')) return false;
      assert.match(error.message, /exited/);
      assert.equal(error.message.includes('stack'), false);
      return true;
    });
  } finally {
    await closeQuiet(connection);
  }
});

test('close is idempotent and settles in-flight work', async () => {
  const connection = await connectFake('hang-prompt');
  const prompt = connection.prompt([{ type: 'text', text: 'hang' }]);
  const first = connection.close(ShutdownDeadline.fromDurationMs(5_000));
  const second = connection.close(ShutdownDeadline.fromDurationMs(30_000));
  await Promise.all([first, second]);
  await assert.rejects(
    prompt,
    (error: unknown) =>
      isConnectionError(error, 'stale_provider_operation') ||
      isConnectionError(error, 'provider_process_exited'),
  );
  await connection.close(ShutdownDeadline.fromDurationMs(1_000));
  assert.equal(connection.state.kind, 'closed');
});

test('close with an already-expired deadline still terminates and does not wait', async () => {
  const connection = await connectFake('ignore-sigterm');
  const started = performance.now();
  await connection.close(ShutdownDeadline.fromDurationMs(0));
  assert.ok(performance.now() - started < 1_000);
  assert.equal(connection.state.kind, 'closed');
});

test('stderr beyond the retained tail is dropped rather than accumulating', async () => {
  const connection = await connectFake('stderr-flood');
  try {
    assert.ok(connection.stderrTail.length <= ACP_STDERR_TAIL_BYTES);
    assert.equal(connection.stderrTail.length, ACP_STDERR_TAIL_BYTES);
    assert.equal(connection.stderrTail.toString(), 'S'.repeat(ACP_STDERR_TAIL_BYTES));
  } finally {
    await closeQuiet(connection);
  }
});

test('a spawn failure for a missing executable reports missing_executable', async () => {
  await assert.rejects(
    () =>
      AcpConnection.connect({
        providerInstanceId: 'cursor',
        spawn: { command: '/definitely/not/an/acp-peer-binary', args: ['acp'] },
        handshake: { authMethodId: 'cursor_login', cwd: process.cwd() },
      }),
    (error: unknown) => {
      assert.ok(isConnectionError(error, 'missing_executable'));
      if (!isConnectionError(error, 'missing_executable')) return false;
      assert.equal(error.recoveryAction, 'open_cursor_setup');
      assert.equal(error.message.includes('ENOENT'), false);
      return true;
    },
  );
});

test('authentication failure reports unauthenticated_provider', async () => {
  await assert.rejects(
    () => connectFake('auth-fail'),
    (error: unknown) => {
      assert.ok(isConnectionError(error, 'unauthenticated_provider'));
      if (!isConnectionError(error, 'unauthenticated_provider')) return false;
      assert.equal(error.message.includes('unauthorized'), false);
      return true;
    },
  );
});

test('ACP_MAX_INBOUND_LINE_BYTES is the cap the oversized peer exceeds', () => {
  assert.equal(ACP_MAX_INBOUND_LINE_BYTES, 8 * 1024 * 1024);
  assert.equal(existsSync(fakeAcpPeerPath()), true);
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
