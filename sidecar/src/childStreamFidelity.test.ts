import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CHILD_TOKEN_STREAM_OPTIONS,
  childTokenStream,
  isStreamFidelity,
  observedChildStreamFidelity,
  publishedStreamFidelity,
} from './childStreamFidelity.js';
import { childSummary, newChildState } from './ChildSessionState.js';

const here = dirname(fileURLToPath(import.meta.url));

function protocolRegion(source: string, marker: string, end: string): string {
  const start = source.indexOf(marker);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0, `missing ${marker}`);
  assert.ok(stop > start, `missing ${end}`);
  return source.slice(start, stop);
}

test('a token stream declaration is coupled to includePartialMessages', () => {
  const stream = childTokenStream();
  assert.equal(stream.fidelity, 'token');
  assert.equal(stream.options.includePartialMessages, true);
  assert.equal(stream.options, CHILD_TOKEN_STREAM_OPTIONS);
});

test('observed children publish state fidelity until a token stream is declared', () => {
  assert.equal(observedChildStreamFidelity(), 'state');
  assert.equal(publishedStreamFidelity(undefined), 'state');
  assert.equal(publishedStreamFidelity('tool'), 'tool');
  const child = newChildState({
    parentAppSessionId: 'parent',
    childSessionId: 'child-a',
    role: 'worker',
    modelId: 'model-default',
    updatedAt: 1,
  });
  assert.equal(childSummary(child).streamFidelity, 'state');
  child.streamFidelity = 'token';
  assert.equal(childSummary(child).streamFidelity, 'token');
});

test('stream fidelity vocabulary is closed', () => {
  assert.equal(isStreamFidelity('token'), true);
  assert.equal(isStreamFidelity('tool'), true);
  assert.equal(isStreamFidelity('state'), true);
  assert.equal(isStreamFidelity('streaming'), false);
  assert.equal(isStreamFidelity(undefined), false);
});

test('protocol stream fidelity types stay mirrored with the renderer', () => {
  const sidecar = readFileSync(join(here, 'protocol.ts'), 'utf8');
  const renderer = readFileSync(join(here, '../../src/types/bridge.ts'), 'utf8');
  const marker = 'export type StreamFidelity =';
  const end = 'export interface ChildSpawnLink {';
  assert.equal(protocolRegion(sidecar, marker, end), protocolRegion(renderer, marker, end));
  assert.match(sidecar, /streamFidelity: StreamFidelity;/);
  assert.match(renderer, /streamFidelity: StreamFidelity;/);
});
