const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TERMINAL_HIDDEN_BUFFER_BYTES = 2 * 1024 * 1024;

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function trimUtf8Prefix(
  text: string,
  dropBytes: number,
): { text: string; droppedBytes: number } {
  if (dropBytes <= 0) return { text, droppedBytes: 0 };
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= dropBytes) {
    return { text: '', droppedBytes: encoded.byteLength };
  }
  let start = dropBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if ((byte & 0xc0) !== 0x80) break;
    start += 1;
  }
  return { text: decoder.decode(encoded.subarray(start)), droppedBytes: start };
}

export function createTerminalOutputPump(options: {
  write: (data: string) => void;
  isHidden: () => boolean;
  scheduleFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  maxHiddenBytes?: number;
}) {
  const maxHiddenBytes = options.maxHiddenBytes ?? TERMINAL_HIDDEN_BUFFER_BYTES;
  let pending = '';
  let pendingBytes = 0;
  let droppedBytes = 0;
  let truncated = false;
  let frame = 0;

  function cancel() {
    if (!frame) return;
    options.cancelFrame(frame);
    frame = 0;
  }

  function capPending() {
    if (pendingBytes <= maxHiddenBytes) return;
    const overflow = pendingBytes - maxHiddenBytes;
    const trimmed = trimUtf8Prefix(pending, overflow);
    pending = trimmed.text;
    pendingBytes = utf8ByteLength(pending);
    droppedBytes += trimmed.droppedBytes;
    truncated = true;
  }

  function flush() {
    cancel();
    if (!pending || options.isHidden()) return;
    const data = pending;
    pending = '';
    pendingBytes = 0;
    options.write(data);
  }

  function push(data: string) {
    if (!data) return;
    pending += data;
    pendingBytes += utf8ByteLength(data);
    if (options.isHidden()) {
      capPending();
      return;
    }
    if (!frame) frame = options.scheduleFrame(flush);
  }

  function reveal() {
    if (options.isHidden()) return;
    flush();
  }

  function dispose() {
    cancel();
    pending = '';
    pendingBytes = 0;
  }

  return {
    push,
    flush,
    reveal,
    dispose,
    get truncated() {
      return truncated;
    },
    get droppedBytes() {
      return droppedBytes;
    },
  };
}
