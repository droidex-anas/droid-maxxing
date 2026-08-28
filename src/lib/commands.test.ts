import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge } from './bridge';
import { exportSessionMarkdown, setBackgroundWork, setHistoryIndexingIdle } from './commands';
import type { ClientCommand, ServerEvent } from '../types/bridge';

// Drives the bridge singleton with an in-memory double; exportSessionMarkdown
// only touches sendIfConnected and subscribe.
function fakeBridge(): {
  sent: ClientCommand[];
  emit: (event: ServerEvent) => void;
  restore: () => void;
} {
  const listeners = new Set<(event: ServerEvent) => void>();
  const sent: ClientCommand[] = [];
  const originalSendIfConnected = bridge.sendIfConnected.bind(bridge);
  const originalSubscribe = bridge.subscribe.bind(bridge);
  bridge.sendIfConnected = (command: ClientCommand): boolean => {
    sent.push(command);
    return true;
  };
  bridge.subscribe = (listener: (event: ServerEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    sent,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    restore: () => {
      bridge.sendIfConnected = originalSendIfConnected;
      bridge.subscribe = originalSubscribe;
    },
  };
}

function exportRequestId(sent: ClientCommand[]): string {
  const command = sent.at(-1);
  assert.ok(command?.type === 'session.exportMarkdown');
  return command.requestId;
}

test('history indexing idle samples are ephemeral and use the connected-only lane', () => {
  const fake = fakeBridge();
  try {
    assert.equal(setHistoryIndexingIdle(true), true);
    assert.deepEqual(fake.sent, [{ type: 'history.indexingIdle', isIdle: true }]);
  } finally {
    fake.restore();
  }
});

test('background work tier samples are ephemeral and use the connected-only lane', () => {
  const fake = fakeBridge();
  try {
    assert.equal(setBackgroundWork('hidden', 'app-1'), true);
    assert.deepEqual(fake.sent, [
      { type: 'app.backgroundWork', tier: 'hidden', focusedAppSessionId: 'app-1' },
    ]);
  } finally {
    fake.restore();
  }
});

test('exportSessionMarkdown resolves the markdown for its own request id only', async () => {
  const fake = fakeBridge();
  try {
    const pending = exportSessionMarkdown('app-1', 'Chat');
    const requestId = exportRequestId(fake.sent);

    fake.emit({ type: 'session.markdownExported', requestId: 'other', ok: true, markdown: '# no' });
    fake.emit({ type: 'session.markdownExported', requestId, ok: true, markdown: '# yes' });

    assert.equal(await pending, '# yes');
  } finally {
    fake.restore();
  }
});

test('exportSessionMarkdown rejects only on its own unsupported-command error, with the code attached', async () => {
  // Version skew: a foreign unsupported command failing concurrently (or one
  // without a request id) must not reject an unrelated in-flight export, and
  // the rejection carries the code so callers can skip a duplicate toast.
  const fake = fakeBridge();
  try {
    const pending = exportSessionMarkdown('app-1', 'Chat');
    const requestId = exportRequestId(fake.sent);

    let settled = false;
    const watched = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    fake.emit({
      type: 'error',
      code: 'bridge.unsupported_command',
      requestId: 'someone-else',
      message: 'foreign',
    });
    fake.emit({ type: 'error', code: 'bridge.unsupported_command', message: 'no id' });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false);

    fake.emit({
      type: 'error',
      code: 'bridge.unsupported_command',
      requestId,
      message: 'restart now',
    });
    await watched;
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'restart now');
      assert.equal((error as { code?: unknown }).code, 'bridge.unsupported_command');
      return true;
    });
  } finally {
    fake.restore();
  }
});
