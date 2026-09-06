import type { ServerEvent, ServerWireMessage } from '../protocol.js';

export interface ReplayWireCursor {
  generation: string | null;
  lastSeq: number;
}

export function messageText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString('utf8');
  return Buffer.from(raw as Buffer).toString('utf8');
}

export function acceptReplayWireMessage(
  message: ServerWireMessage,
  cursor: ReplayWireCursor,
): ServerEvent[] {
  if (message.type === 'bridge.reset') {
    throw new Error(`Replay bridge reset: ${message.reason}.`);
  }
  if (message.type !== 'events.batch') {
    throw new Error(`Replay bridge expected an event batch, received ${message.type}.`);
  }
  if (cursor.generation !== null && message.generation !== cursor.generation) {
    throw new Error('Replay bridge generation changed during the run.');
  }
  if (
    (cursor.generation !== null && message.firstSeq !== cursor.lastSeq + 1) ||
    message.lastSeq < message.firstSeq
  ) {
    throw new Error('Replay bridge sequence gap or overlap.');
  }
  if (message.events.length === 0) throw new Error('Replay bridge delivered an empty batch.');

  let previousSeq = message.firstSeq - 1;
  for (const entry of message.events) {
    if (
      !Number.isSafeInteger(entry.seq) ||
      entry.seq <= previousSeq ||
      entry.seq < message.firstSeq ||
      entry.seq > message.lastSeq
    ) {
      throw new Error('Replay bridge entry order is invalid.');
    }
    previousSeq = entry.seq;
  }
  if (previousSeq !== message.lastSeq) {
    throw new Error('Replay bridge batch does not represent its final sequence.');
  }

  cursor.generation = message.generation;
  cursor.lastSeq = message.lastSeq;
  return message.events.map((entry) => entry.event);
}
