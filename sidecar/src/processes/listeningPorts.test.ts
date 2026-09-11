import assert from 'node:assert/strict';
import test from 'node:test';
import { listListeningPorts, parseLsofListeners } from './listeningPorts.js';

test('parseLsofListeners groups ports by pid', () => {
  const out = ['p800', 'n*:5173', 'n[::1]:5173', 'p900', 'n127.0.0.1:3000', 'n127.0.0.1:3001'].join(
    '\n',
  );
  const ports = parseLsofListeners(out);
  assert.deepEqual(ports.get(800), [5173]);
  assert.deepEqual(ports.get(900), [3000, 3001]);
});

test('a failed lsof run yields null so the caller keeps its previous ports', async () => {
  assert.equal(
    await listListeningPorts(() => Promise.reject(new Error('spawn lsof ENOENT'))),
    null,
  );
});

test('output produced alongside a warning is still parsed', async () => {
  const ports = await listListeningPorts(() => Promise.resolve(['p800', 'n*:5173'].join('\n')));
  assert.deepEqual(ports?.get(800), [5173]);
});
