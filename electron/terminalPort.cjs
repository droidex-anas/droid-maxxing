// Per-subscription MessagePort data plane for utility-pane terminals.
// Control IPC (create/resize/kill/list) stays in main.cjs. This registry owns
// port lifetime, output batching, and bounded pending-byte backpressure.
//
// Cleanup is idempotent: unsubscribe, PTY exit, port close, sender destroy,
// renderer navigation, window close, and app quit all release the same link.

const { MAX_REPLAY_BYTES } = require('./terminal.cjs');

// 4 ms coalesces PTY bursts inside a fraction of a 60 Hz frame. 32 KiB is
// past the structured-clone cost knee (~16 KiB) and still one xterm parse.
const TERMINAL_BATCH_WINDOW_MS = 4;
const TERMINAL_BATCH_MAX_BYTES = 32 * 1024;
const TERMINAL_MAX_PENDING_BYTES = MAX_REPLAY_BYTES;
// Match one output batch: a keystroke/paste stays in the same size class as a
// PTY flush; a renderer cannot dump megabytes into node-pty in one post.
const TERMINAL_MAX_INPUT_BYTES = TERMINAL_BATCH_MAX_BYTES;

function payloadBytes(payload) {
  if (!payload || typeof payload.data !== 'string') return 0;
  return Buffer.byteLength(payload.data, 'utf8');
}

function boundPayload(payload, remainingBytes) {
  const bytes = payloadBytes(payload);
  if (bytes === 0) return payload;
  if (remainingBytes <= 0) return null;
  if (bytes <= remainingBytes) return payload;
  const buf = Buffer.from(payload.data, 'utf8');
  let start = buf.length - remainingBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return {
    ...payload,
    data: buf.subarray(start).toString('utf8'),
    truncated: true,
    droppedBytes: (payload.droppedBytes || 0) + start,
  };
}

function messageData(event) {
  if (event && typeof event === 'object' && 'data' in event) return event.data;
  return event;
}

function resyncPayload(terminalManager, terminalId, fromByteOffset) {
  return { kind: 'data', ...terminalManager.replaySince(terminalId, fromByteOffset) };
}

function createPortLink(options) {
  const {
    port,
    sender,
    terminalId,
    terminalManager,
    scheduleTimeout,
    cancelTimeout,
    batchWindowMs,
    batchMaxBytes,
    maxPendingBytes,
    maxInputBytes,
    onClosed,
  } = options;

  let closed = false;
  let overflowed = false;
  let unackedBytes = 0;
  let lastAckedByteOffset = 0;
  let pendingChunks = [];
  let pendingBytes = 0;
  let pendingSequence = 0;
  let pendingByteOffset = 0;
  let flushTimer = null;
  let disposeManager = null;
  let detachPort = () => {};

  function cancelFlush() {
    if (!flushTimer) return;
    cancelTimeout(flushTimer);
    flushTimer = null;
  }

  function senderGone() {
    return typeof sender.isDestroyed === 'function' && sender.isDestroyed();
  }

  function post(payload) {
    if (closed || senderGone()) {
      close();
      return false;
    }
    try {
      port.postMessage(payload);
    } catch {
      close();
      return false;
    }
    const bytes = payloadBytes(payload);
    if (bytes > 0) {
      unackedBytes += bytes;
      if (unackedBytes >= maxPendingBytes) overflowed = true;
    }
    return true;
  }

  function flush() {
    cancelFlush();
    if (closed || pendingChunks.length === 0) return;
    const remaining = maxPendingBytes - unackedBytes;
    if (pendingBytes > remaining) {
      pendingChunks = [];
      pendingBytes = 0;
      overflowed = true;
      return;
    }
    const data = pendingChunks.join('');
    const sequence = pendingSequence;
    const byteOffset = pendingByteOffset;
    pendingChunks = [];
    pendingBytes = 0;
    post({ kind: 'data', data, sequence, byteOffset });
  }

  function enqueueData(payload) {
    if (closed || overflowed) return;
    const remaining = maxPendingBytes - unackedBytes;
    if (remaining <= 0) {
      overflowed = true;
      return;
    }
    pendingChunks.push(payload.data);
    pendingBytes += payloadBytes(payload);
    pendingSequence = payload.sequence;
    pendingByteOffset = payload.byteOffset;
    if (pendingBytes >= batchMaxBytes || pendingBytes >= remaining) {
      flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = scheduleTimeout(() => {
        flushTimer = null;
        flush();
      }, batchWindowMs);
    }
  }

  function resync() {
    if (closed) return;
    let payload;
    try {
      payload = resyncPayload(terminalManager, terminalId, lastAckedByteOffset);
    } catch {
      close();
      return;
    }
    overflowed = false;
    const remaining = maxPendingBytes - unackedBytes;
    payload = boundPayload(payload, remaining);
    if (!payload) {
      overflowed = true;
      return;
    }
    if (payload.byteOffset <= lastAckedByteOffset && payload.data.length === 0) return;
    post(payload);
  }

  function onManagerEvent(payload) {
    if (closed) return;
    if (payload.kind === 'replay') {
      const remaining = maxPendingBytes - unackedBytes;
      const bounded = boundPayload(
        {
          kind: 'replay',
          data: payload.data,
          sequence: payload.sequence,
          truncated: payload.truncated,
          droppedBytes: payload.droppedBytes,
          byteOffset: payload.byteOffset,
          totalEmittedBytes: payload.totalEmittedBytes,
        },
        remaining,
      );
      if (bounded) post(bounded);
      else overflowed = true;
      return;
    }
    if (payload.kind === 'data') {
      enqueueData(payload);
      return;
    }
    if (payload.kind === 'exit') {
      if (overflowed) resync();
      else flush();
      post({
        kind: 'exit',
        sequence: payload.sequence,
        exitCode: payload.exitCode,
        signal: payload.signal,
      });
      close();
    }
  }

  function onPortMessage(event) {
    if (closed) return;
    try {
      const data = messageData(event);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.type === 'input') {
        if (typeof data.data !== 'string') return;
        if (Buffer.byteLength(data.data, 'utf8') > maxInputBytes) return;
        try {
          terminalManager.write(terminalId, data.data);
        } catch {
          // PTY may have exited between the keystroke and this turn.
        }
        return;
      }
      if (data.type !== 'ack') return;
      const bytes = data.bytes;
      const byteOffset = data.byteOffset;
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return;
      if (typeof byteOffset !== 'number' || !Number.isFinite(byteOffset) || byteOffset < 0) return;
      if (bytes > 0) unackedBytes = Math.max(0, unackedBytes - bytes);
      if (byteOffset > lastAckedByteOffset) lastAckedByteOffset = byteOffset;
      if (overflowed && unackedBytes < maxPendingBytes / 2) resync();
    } catch {
      // Malformed renderer messages must not tear down the PTY or the port.
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    cancelFlush();
    pendingChunks = [];
    pendingBytes = 0;
    if (disposeManager) {
      disposeManager();
      disposeManager = null;
    }
    detachPort();
    try {
      port.close();
    } catch {
      // already closed by the peer
    }
    onClosed();
  }

  function attach() {
    if (typeof port.start === 'function') port.start();
    const onMessage = (event) => onPortMessage(event);
    const onClose = () => close();
    port.on('message', onMessage);
    port.on('close', onClose);
    detachPort = () => {
      port.removeListener?.('message', onMessage);
      port.removeListener?.('close', onClose);
      port.off?.('message', onMessage);
      port.off?.('close', onClose);
      detachPort = () => {};
    };
    disposeManager = terminalManager.subscribe(terminalId, onManagerEvent);
  }

  return {
    attach,
    close,
    get closed() {
      return closed;
    },
    get unackedBytes() {
      return unackedBytes;
    },
    get overflowed() {
      return overflowed;
    },
  };
}

function createTerminalSubscriptionRegistry(terminalManager, options = {}) {
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  const batchWindowMs = options.batchWindowMs ?? TERMINAL_BATCH_WINDOW_MS;
  const batchMaxBytes = options.batchMaxBytes ?? TERMINAL_BATCH_MAX_BYTES;
  const maxPendingBytes = options.maxPendingBytes ?? TERMINAL_MAX_PENDING_BYTES;
  const maxInputBytes = options.maxInputBytes ?? TERMINAL_MAX_INPUT_BYTES;
  const senders = new Map();

  function clear(senderId) {
    const entries =
      senderId === undefined ? [...senders.entries()] : [[senderId, senders.get(senderId)]];
    for (const [id, entry] of entries) {
      if (!entry) continue;
      entry.sender.removeListener('destroyed', entry.onDestroyed);
      for (const link of entry.subscriptions.values()) link.close();
      senders.delete(id);
    }
  }

  function unsubscribe(sender, terminalId) {
    const subscriptions = senders.get(sender.id)?.subscriptions;
    const link = subscriptions?.get(terminalId);
    if (link) link.close();
    subscriptions?.delete(terminalId);
  }

  function subscribe(sender, terminalId, port) {
    if (!port || typeof port.postMessage !== 'function') {
      throw new Error('subscribe() requires a MessagePort');
    }
    unsubscribe(sender, terminalId);
    let entry = senders.get(sender.id);
    if (!entry) {
      const onDestroyed = () => clear(sender.id);
      entry = { sender, onDestroyed, subscriptions: new Map() };
      senders.set(sender.id, entry);
      sender.once('destroyed', onDestroyed);
    }
    const link = createPortLink({
      port,
      sender,
      terminalId,
      terminalManager,
      scheduleTimeout,
      cancelTimeout,
      batchWindowMs,
      batchMaxBytes,
      maxPendingBytes,
      maxInputBytes,
      onClosed: () => {
        const current = senders.get(sender.id);
        if (current?.subscriptions.get(terminalId) === link) {
          current.subscriptions.delete(terminalId);
        }
      },
    });
    entry.subscriptions.set(terminalId, link);
    try {
      link.attach();
    } catch (error) {
      try {
        port.postMessage({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // port already closed
      }
      link.close();
      throw error;
    }
    return link;
  }

  return { subscribe, unsubscribe, clear };
}

module.exports = {
  createTerminalSubscriptionRegistry,
  TERMINAL_BATCH_WINDOW_MS,
  TERMINAL_BATCH_MAX_BYTES,
  TERMINAL_MAX_PENDING_BYTES,
  TERMINAL_MAX_INPUT_BYTES,
};
