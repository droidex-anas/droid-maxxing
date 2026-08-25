/**
 * Production JSONL extraction and snippet shaping for the worker-owned
 * SQLite search index. This module never searches the raw corpus itself.
 */
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  parseSessionLineEvents,
  type StoredMessageLine,
  type StoredSessionStart,
} from './sessionTranscriptParser.js';
import type { TranscriptEvent } from './protocol.js';

export interface SessionSearchCandidate {
  providerSessionId: string;
  appSessionId: string;
  path: string;
  sizeBytes: number;
}

export interface SessionSearchRecord {
  sourceByteOffset: number;
  eventIndex: number;
  ts: number;
  author: 'user' | 'assistant';
  text: string;
}

export interface SessionSearchSlice {
  records: SessionSearchRecord[];
  nextByteOffset: number;
  reachedEnd: boolean;
  tailFingerprint: string;
}

const SNIPPET_RADIUS = 70;
const READ_BUFFER_BYTES = 64 * 1024;
const FINGERPRINT_BYTES = 4 * 1024;
export const DEFAULT_SEARCH_SLICE_BYTES = 256 * 1024;

export async function readSessionSearchSlice(
  candidate: SessionSearchCandidate,
  startByteOffset: number,
  maxBytes = DEFAULT_SEARCH_SLICE_BYTES,
): Promise<SessionSearchSlice> {
  assertSearchSliceInput(startByteOffset, maxBytes);
  const handle = await open(candidate.path, 'r');
  const records: SessionSearchRecord[] = [];
  let position = Math.min(startByteOffset, candidate.sizeBytes);
  let nextByteOffset = position;
  let lineParts: Buffer[] = [];
  let lineBytes = 0;
  let lineStartByteOffset = position;
  let isDiscardingLine = !(await startsAtLineBoundary(handle, position));
  try {
    while (position < candidate.sizeBytes) {
      const readSize = Math.min(READ_BUFFER_BYTES, candidate.sizeBytes - position);
      const buffer = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, position);
      if (bytesRead === 0) break;
      let lineStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 10) continue;
        ({ lineBytes, isDiscardingLine } = appendLinePart(
          lineParts,
          lineBytes,
          isDiscardingLine,
          buffer.subarray(lineStart, index),
        ));
        if (!isDiscardingLine) {
          appendSearchRecords(
            candidate,
            Buffer.concat(lineParts).toString('utf8'),
            lineStartByteOffset,
            records,
          );
        }
        lineParts = [];
        lineBytes = 0;
        isDiscardingLine = false;
        nextByteOffset = position + index + 1;
        lineStartByteOffset = nextByteOffset;
        lineStart = index + 1;
        if (nextByteOffset - startByteOffset >= maxBytes) {
          return {
            records,
            nextByteOffset,
            reachedEnd: nextByteOffset >= candidate.sizeBytes,
            tailFingerprint: await sessionSearchFingerprint(candidate.path, nextByteOffset),
          };
        }
      }
      if (lineStart < bytesRead) {
        ({ lineBytes, isDiscardingLine } = appendLinePart(
          lineParts,
          lineBytes,
          isDiscardingLine,
          buffer.subarray(lineStart, bytesRead),
        ));
      }
      position += bytesRead;
      if (isDiscardingLine && position - startByteOffset >= maxBytes) {
        nextByteOffset = position;
        return {
          records,
          nextByteOffset,
          reachedEnd: nextByteOffset >= candidate.sizeBytes,
          tailFingerprint: await sessionSearchFingerprint(candidate.path, nextByteOffset),
        };
      }
    }

    nextByteOffset = completeFinalSearchLine({
      candidate,
      records,
      lineParts,
      lineStartByteOffset,
      position,
      nextByteOffset,
      isDiscardingLine,
    });
    return {
      records,
      nextByteOffset,
      reachedEnd: nextByteOffset >= candidate.sizeBytes,
      tailFingerprint: await sessionSearchFingerprint(candidate.path, nextByteOffset),
    };
  } finally {
    await handle.close();
  }
}

function assertSearchSliceInput(startByteOffset: number, maxBytes: number): void {
  if (!Number.isSafeInteger(startByteOffset) || startByteOffset < 0) {
    throw new Error('Session search byte offset must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Session search slice size must be a positive safe integer.');
  }
}

function completeFinalSearchLine({
  candidate,
  records,
  lineParts,
  lineStartByteOffset,
  position,
  nextByteOffset,
  isDiscardingLine,
}: {
  candidate: SessionSearchCandidate;
  records: SessionSearchRecord[];
  lineParts: Buffer[];
  lineStartByteOffset: number;
  position: number;
  nextByteOffset: number;
  isDiscardingLine: boolean;
}): number {
  if (isDiscardingLine) return position;
  if (lineParts.length === 0) return nextByteOffset;
  const raw = Buffer.concat(lineParts).toString('utf8');
  return appendSearchRecords(candidate, raw, lineStartByteOffset, records)
    ? position
    : nextByteOffset;
}

async function startsAtLineBoundary(
  handle: Awaited<ReturnType<typeof open>>,
  byteOffset: number,
): Promise<boolean> {
  if (byteOffset === 0) return true;
  const previousByte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(previousByte, 0, 1, byteOffset - 1);
  return bytesRead === 1 && previousByte[0] === 10;
}

function appendLinePart(
  lineParts: Buffer[],
  lineBytes: number,
  isDiscardingLine: boolean,
  part: Buffer,
): { lineBytes: number; isDiscardingLine: boolean } {
  if (isDiscardingLine) return { lineBytes: 0, isDiscardingLine: true };
  const nextLineBytes = lineBytes + part.length;
  lineParts.push(part);
  return { lineBytes: nextLineBytes, isDiscardingLine: false };
}

export async function sessionSearchFingerprint(
  path: string,
  endByteOffset: number,
): Promise<string> {
  const startByteOffset = Math.max(0, endByteOffset - FINGERPRINT_BYTES);
  const length = endByteOffset - startByteOffset;
  if (length === 0) return createHash('sha256').digest('base64url');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, startByteOffset);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('base64url');
  } finally {
    await handle.close();
  }
}

function appendSearchRecords(
  candidate: SessionSearchCandidate,
  raw: string,
  sourceByteOffset: number,
  records: SessionSearchRecord[],
): boolean {
  let events: TranscriptEvent[];
  try {
    events = parseSessionLineEvents(
      candidate.appSessionId,
      candidate.providerSessionId,
      'primary',
      JSON.parse(raw) as StoredMessageLine | StoredSessionStart,
    );
  } catch {
    return false;
  }
  events.forEach((event, eventIndex) => {
    if (event.kind !== 'text' || !event.text) return;
    records.push({
      sourceByteOffset,
      eventIndex,
      ts: event.ts,
      author: event.author === 'user' ? 'user' : 'assistant',
      text: event.text.replace(/\s+/g, ' '),
    });
  });
  return true;
}

export function buildSessionSearchSnippet(text: string, queryLower: string): string | null {
  const index = text.toLowerCase().indexOf(queryLower);
  if (index < 0) return null;
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + queryLower.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
