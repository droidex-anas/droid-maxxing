import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { isLlmOnlyMessage } from './sessionTranscriptParser.js';
import { objectValue } from './values.js';

const SCAN_CHUNK_BYTES = 64 * 1024;

export function hasCompletedConversation(path: string, sizeBytes: number): boolean {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, Math.max(1, sizeBytes)));
    const decoder = new StringDecoder('utf8');
    let offset = 0;
    let pending = '';
    let hasUserMessage = false;
    let hasAssistantMessage = false;
    const inspect = (line: string): boolean => {
      const role = storedMessageRole(line);
      if (role === 'user') hasUserMessage = true;
      if (role === 'assistant') hasAssistantMessage = true;
      return hasUserMessage && hasAssistantMessage;
    };

    while (offset < sizeBytes) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const lines = `${pending}${decoder.write(chunk.subarray(0, bytesRead))}`.split(/\r?\n/);
      pending = lines.pop() ?? '';
      if (lines.some(inspect)) return true;
    }
    pending += decoder.end();
    return pending.length > 0 && inspect(pending);
  } finally {
    closeSync(fd);
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
