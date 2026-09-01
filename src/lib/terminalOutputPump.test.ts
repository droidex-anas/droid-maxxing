import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerminalOutputPump,
  TERMINAL_HIDDEN_BUFFER_BYTES,
  trimUtf8Prefix,
  utf8ByteLength,
} from './terminalOutputPump';

test('output pump coalesces visible writes onto one animation frame', () => {
  const writes: string[] = [];
  const frames: Array<() => void> = [];
  const pump = createTerminalOutputPump({
    write: (data) => writes.push(data),
    isHidden: () => false,
    scheduleFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {
      frames.length = 0;
    },
  });

  pump.push('a');
  pump.push('b');
  pump.push('c');
  assert.deepEqual(writes, []);
  assert.equal(frames.length, 1);

  frames[0]?.();
  assert.deepEqual(writes, ['abc']);
});

test('output pump skips xterm writes while hidden and flushes on reveal', () => {
  const writes: string[] = [];
  let hidden = true;
  const frames: Array<() => void> = [];
  const pump = createTerminalOutputPump({
    write: (data) => writes.push(data),
    isHidden: () => hidden,
    scheduleFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {
      frames.length = 0;
    },
  });

  pump.push('hello');
  assert.deepEqual(writes, []);
  assert.equal(frames.length, 0);

  hidden = false;
  pump.reveal();
  assert.deepEqual(writes, ['hello']);
});

test('hidden output is bounded with UTF-8-safe trimming', () => {
  const writes: string[] = [];
  const pump = createTerminalOutputPump({
    write: (data) => writes.push(data),
    isHidden: () => true,
    scheduleFrame: () => 1,
    cancelFrame: () => undefined,
    maxHiddenBytes: 8,
  });

  pump.push(`🙂${'a'.repeat(10)}`);
  assert.equal(pump.truncated, true);
  assert.equal(pump.droppedBytes > 0, true);
  assert.equal(utf8ByteLength(trimUtf8Prefix(`🙂${'a'.repeat(10)}`, 6).text) <= 8, true);
  assert.deepEqual(writes, []);
});

test('hidden buffer cap matches the replay window by default', () => {
  assert.equal(TERMINAL_HIDDEN_BUFFER_BYTES, 2 * 1024 * 1024);
});
