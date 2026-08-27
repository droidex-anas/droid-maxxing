import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { isLlmOnlyMessage } from './sessionTranscriptParser.js';
import type { StoredSessionStart } from './sessionTranscript.js';
import { objectValue } from './values.js';

// Everything the session list needs from one on-disk session file. Building a
// sidebar row must never depend on the transcript body, so this is the only
// read the discovery path performs per file.
export interface SessionFileHead {
  start: StoredSessionStart;
  // A provider writes session_start before the first prompt, so an interrupted
  // or abandoned turn leaves a valid file with no completed exchange. Those are
  // not durable conversations and must not become permanent sidebar rows.
  hasCompletedConversation: boolean;
}

const SCAN_CHUNK_BYTES = 64 * 1024;
// The session_start record is the first JSONL line, so give up on finding it
// after a few lines rather than parsing an entire head.
const MAX_START_LINES = 8;

export function readSessionFileHead(path: string, sizeBytes: number): SessionFileHead {
  let start: StoredSessionStart | undefined;
  let startLines = 0;
  let hasUserMessage = false;
  let hasAssistantMessage = false;

  for (const line of sessionLines(path, sizeBytes)) {
    if (!start && startLines < MAX_START_LINES) {
      startLines += 1;
      start = parseSessionStart(line);
    }
    const role = storedMessageRole(line);
    if (role === 'user') hasUserMessage = true;
    if (role === 'assistant') hasAssistantMessage = true;
    // Both answers are settled; nothing further in the file can change them.
    const startSettled = start !== undefined || startLines >= MAX_START_LINES;
    if (startSettled && hasUserMessage && hasAssistantMessage) break;
  }

  return {
    start: start ?? {},
    hasCompletedConversation: hasUserMessage && hasAssistantMessage,
  };
}

export function readSessionStart(path: string, sizeBytes: number): StoredSessionStart {
  let lines = 0;
  for (const line of sessionLines(path, sizeBytes)) {
    lines += 1;
    const start = parseSessionStart(line);
    if (start) return start;
    if (lines >= MAX_START_LINES) break;
  }
  return {};
}

// Streams complete JSONL lines from the head of the file. Callers that break
// out early never pay for the transcript body behind them.
function* sessionLines(path: string, sizeBytes: number): Generator<string> {
  if (sizeBytes <= 0) return;
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, sizeBytes));
    const decoder = new StringDecoder('utf8');
    let offset = 0;
    let pending = '';
    while (offset < sizeBytes) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const lines = `${pending}${decoder.write(chunk.subarray(0, bytesRead))}`.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line) yield line;
    }
    pending += decoder.end();
    if (pending) yield pending;
  } finally {
    closeSync(fd);
  }
}

function parseSessionStart(line: string): StoredSessionStart | undefined {
  try {
    const row = JSON.parse(line) as StoredSessionStart;
    return row.type === 'session_start' ? row : undefined;
  } catch {
    return undefined;
  }
}

function storedMessageRole(line: string): 'user' | 'assistant' | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    const record = objectValue(parsed);
    if (record?.type !== 'message') return undefined;
    const message = objectValue(record.message);
    if (isLlmOnlyMessage(message)) return undefined;
    const role = message?.role;
    return role === 'user' || role === 'assistant' ? role : undefined;
  } catch {
    return undefined;
  }
}
