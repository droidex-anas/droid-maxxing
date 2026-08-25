import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildSessionSearchSnippet,
  DEFAULT_SEARCH_SLICE_BYTES,
  readSessionSearchSlice,
  type SessionSearchCandidate,
  type SessionSearchRecord,
} from './sessionSearch.js';

function messageLine(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  ts: number,
  visibility?: string,
): string {
  return JSON.stringify({
    id,
    type: 'message',
    timestamp: new Date(ts).toISOString(),
    message: {
      role,
      ...(visibility ? { visibility } : {}),
      content: [{ type: 'text', text }],
    },
  });
}

function toolUseLine(id: string, input: string, ts: number): string {
  return JSON.stringify({
    id,
    type: 'message',
    timestamp: new Date(ts).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input }] },
  });
}

function writeSession(lines: string[]): { candidate: SessionSearchCandidate; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'session-search-extraction-'));
  const path = join(directory, 'provider.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  const stat = statSync(path);
  return {
    directory,
    candidate: {
      providerSessionId: 'provider',
      appSessionId: 'app',
      path,
      sizeBytes: stat.size,
    },
  };
}

async function readAll(candidate: SessionSearchCandidate): Promise<SessionSearchRecord[]> {
  const records: SessionSearchRecord[] = [];
  let byteOffset = 0;
  for (;;) {
    const slice = await readSessionSearchSlice(candidate, byteOffset, 1);
    assert.ok(slice.nextByteOffset > byteOffset || slice.reachedEnd);
    records.push(...slice.records);
    byteOffset = slice.nextByteOffset;
    if (slice.reachedEnd) return records;
  }
}

function content(
  records: SessionSearchRecord[],
): Omit<SessionSearchRecord, 'sourceByteOffset' | 'eventIndex'>[] {
  return records.map(({ ts, author, text }) => ({ ts, author, text }));
}

test('extracts searchable user and assistant text with whitespace flattened', async () => {
  const fixture = writeSession([
    messageLine('one', 'user', 'hello\nthere', 1_000),
    messageLine('two', 'assistant', 'general   kenobi', 2_000),
  ]);
  try {
    assert.deepEqual(content(await readAll(fixture.candidate)), [
      { ts: 1_000, author: 'user', text: 'hello there' },
      { ts: 2_000, author: 'assistant', text: 'general kenobi' },
    ]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('excludes tool IO, llm-only context, internal notices, and corrupt lines', async () => {
  const fixture = writeSession([
    toolUseLine('tool', 'grep secret src/', 1_000),
    messageLine('hidden', 'user', 'private review instructions', 2_000, 'llm_only'),
    messageLine(
      'internal',
      'user',
      '<system-notification>private review instructions</system-notification>',
      3_000,
    ),
    '{not-json',
    messageLine('visible', 'user', 'the token llm_only is ordinary chat here', 4_000),
  ]);
  try {
    assert.deepEqual(content(await readAll(fixture.candidate)), [
      { ts: 4_000, author: 'user', text: 'the token llm_only is ordinary chat here' },
    ]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('oversized JSONL records remain searchable and advance at a complete-record boundary', async () => {
  const oversized = messageLine(
    'oversized',
    'user',
    `do not retain ${'x'.repeat(DEFAULT_SEARCH_SLICE_BYTES * 4)}`,
    1_000,
  );
  const wanted = messageLine('wanted', 'assistant', 'bounded otter marker', 2_000);
  const fixture = writeSession([oversized, wanted]);
  try {
    const first = await readSessionSearchSlice(fixture.candidate, 0, DEFAULT_SEARCH_SLICE_BYTES);
    assert.ok(first.nextByteOffset > DEFAULT_SEARCH_SLICE_BYTES);
    assert.equal(first.records.length, 1);
    assert.equal(first.records[0]?.author, 'user');
    assert.ok(first.records[0]?.text.startsWith('do not retain'));
    assert.deepEqual(content(await readAllFrom(fixture.candidate, first.nextByteOffset)), [
      { ts: 2_000, author: 'assistant', text: 'bounded otter marker' },
    ]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('centers and ellipsizes a case-insensitive search snippet', () => {
  const text = `${'x'.repeat(120)} Needle in a haystack ${'y'.repeat(120)}`;
  const snippet = buildSessionSearchSnippet(text, 'needle');
  assert.ok(snippet);
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
  assert.ok(snippet.includes('Needle in a haystack'));
  assert.equal(buildSessionSearchSnippet(text, 'missing'), null);
});

async function readAllFrom(
  candidate: SessionSearchCandidate,
  initialByteOffset: number,
): Promise<SessionSearchRecord[]> {
  const records: SessionSearchRecord[] = [];
  let byteOffset = initialByteOffset;
  for (;;) {
    const slice = await readSessionSearchSlice(candidate, byteOffset);
    assert.ok(slice.nextByteOffset > byteOffset || slice.reachedEnd);
    records.push(...slice.records);
    byteOffset = slice.nextByteOffset;
    if (slice.reachedEnd) return records;
  }
}
