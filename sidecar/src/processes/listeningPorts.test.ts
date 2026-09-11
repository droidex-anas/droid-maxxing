import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLsofListeners } from './listeningPorts.js';

test('parseLsofListeners groups ports by pid', () => {
  const out = ['p800', 'n*:5173', 'n[::1]:5173', 'p900', 'n127.0.0.1:3000', 'n127.0.0.1:3001'].join(
    '\n',
  );
  const ports = parseLsofListeners(out);
  assert.deepEqual(ports.get(800), [5173]);
  assert.deepEqual(ports.get(900), [3000, 3001]);
});
