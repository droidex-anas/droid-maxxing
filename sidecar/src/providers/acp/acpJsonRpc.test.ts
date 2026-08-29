import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACP_MAX_INBOUND_LINE_BYTES,
  classifyJsonRpcMessage,
  decodeJsonRpcLine,
  encodeJsonRpcError,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeJsonRpcResult,
  isJsonRpcId,
  jsonRpcIdKey,
  NdjsonLineReader,
} from './acpJsonRpc.js';

test('numeric id 0 is a request, not a notification', () => {
  const decoded = decodeJsonRpcLine(
    '{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"s"}}',
  );
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.message.kind, 'request');
  if (decoded.message.kind !== 'request') return;
  assert.equal(decoded.message.id, 0);
  assert.equal(typeof decoded.message.id, 'number');
  assert.equal(decoded.message.method, 'session/request_permission');
});

test('a truthy check on id 0 would misclassify the request as a notification', () => {
  const parsed: unknown = JSON.parse(
    '{"jsonrpc":"2.0","id":0,"method":"session/request_permission"}',
  );
  assert.equal(isPlainObject(parsed), true);
  if (!isPlainObject(parsed)) return;
  const naiveIsRequest = Boolean(parsed.id) && typeof parsed.method === 'string';
  assert.equal(naiveIsRequest, false);
  const decoded = classifyJsonRpcMessage(parsed);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.message.kind, 'request');
});

test('string ids are preserved as strings', () => {
  const decoded = decodeJsonRpcLine(
    '{"jsonrpc":"2.0","id":"perm-1","method":"cursor/ask_question","params":{}}',
  );
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.message.kind, 'request');
  if (decoded.message.kind !== 'request') return;
  assert.equal(decoded.message.id, 'perm-1');
  assert.equal(typeof decoded.message.id, 'string');
});

test('encodeJsonRpcResult echoes numeric 0 without coercing it to a string or omitting it', () => {
  const encoded = encodeJsonRpcResult(0, { outcome: 'selected' });
  assert.equal(encoded.endsWith('\n'), true);
  assert.equal(encoded.includes('"id":0'), true);
  assert.equal(encoded.includes('"id":"0"'), false);
  const decoded = decodeJsonRpcLine(encoded.trimEnd());
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.message.kind, 'success');
  if (decoded.message.kind !== 'success') return;
  assert.equal(decoded.message.id, 0);
  assert.equal(typeof decoded.message.id, 'number');
});

test('encodeJsonRpcResult echoes a string id as a string', () => {
  const encoded = encodeJsonRpcResult('perm-1', { ok: true });
  assert.equal(encoded.includes('"id":"perm-1"'), true);
  const decoded = decodeJsonRpcLine(encoded.trimEnd());
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  if (decoded.message.kind !== 'success') {
    assert.fail('expected success');
    return;
  }
  assert.equal(decoded.message.id, 'perm-1');
});

test('notifications omit id and are never treated as requests', () => {
  const encoded = encodeJsonRpcNotification('session/update', { sessionId: 's-1' });
  assert.equal(encoded.includes('"id"'), false);
  const decoded = decodeJsonRpcLine(encoded.trimEnd());
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.message.kind, 'notification');
  if (decoded.message.kind !== 'notification') return;
  assert.equal(decoded.message.method, 'session/update');
});

test('jsonRpcIdKey distinguishes numeric 0 from the string "0"', () => {
  assert.notEqual(jsonRpcIdKey(0), jsonRpcIdKey('0'));
  assert.equal(isJsonRpcId(0), true);
  assert.equal(isJsonRpcId('0'), true);
  assert.equal(isJsonRpcId(null), false);
  assert.equal(isJsonRpcId(undefined), false);
});

test('malformed JSON is rejected without throwing', () => {
  assert.deepEqual(decodeJsonRpcLine('{not-json'), { ok: false, failure: 'malformed_json' });
  assert.deepEqual(decodeJsonRpcLine(''), { ok: false, failure: 'malformed_json' });
});

test('JSON that is not a JSON-RPC 2.0 message is rejected', () => {
  assert.deepEqual(decodeJsonRpcLine('[]'), { ok: false, failure: 'invalid_message' });
  assert.deepEqual(decodeJsonRpcLine('"hello"'), { ok: false, failure: 'invalid_message' });
  assert.deepEqual(decodeJsonRpcLine('{"jsonrpc":"1.0","method":"x"}'), {
    ok: false,
    failure: 'invalid_message',
  });
});

test('success and error responses correlate by exact id type', () => {
  const success = decodeJsonRpcLine('{"jsonrpc":"2.0","id":2,"result":{"ok":true}}');
  const failure = decodeJsonRpcLine(
    '{"jsonrpc":"2.0","id":"abc","error":{"code":-32601,"message":"no"}}',
  );
  assert.equal(success.ok, true);
  assert.equal(failure.ok, true);
  if (!success.ok || !failure.ok) return;
  assert.equal(success.message.kind, 'success');
  assert.equal(failure.message.kind, 'error');
});

test('NdjsonLineReader splits complete lines and retains a bounded partial', () => {
  const reader = new NdjsonLineReader(64);
  const first = reader.push(Buffer.from('{"a":1}\n{"b":'));
  assert.equal(first.kind, 'lines');
  if (first.kind !== 'lines') return;
  assert.deepEqual(first.lines, ['{"a":1}']);
  assert.equal(reader.pendingBytes, 5);
  const second = reader.push(Buffer.from('2}\n'));
  assert.equal(second.kind, 'lines');
  if (second.kind !== 'lines') return;
  assert.deepEqual(second.lines, ['{"b":2}']);
  assert.equal(reader.pendingBytes, 0);
});

test('a line exceeding the maximum size fails without retaining the overflow', () => {
  const max = 16;
  const reader = new NdjsonLineReader(max);
  const result = reader.push(Buffer.from('x'.repeat(max + 1)));
  assert.equal(result.kind, 'oversized');
  assert.equal(reader.pendingBytes, 0);
  const after = reader.push(Buffer.from('{"ok":true}\n'));
  assert.equal(after.kind, 'oversized');
  assert.equal(reader.pendingBytes, 0);
});

test('an oversized completed line fails even when a newline eventually arrives', () => {
  const max = 8;
  const reader = new NdjsonLineReader(max);
  assert.equal(reader.push(Buffer.from('x'.repeat(max + 1) + '\n')).kind, 'oversized');
  assert.equal(reader.pendingBytes, 0);
});

test('invalid UTF-8 is rejected fatally', () => {
  const reader = new NdjsonLineReader();
  const result = reader.push(Buffer.from([0xff, 0x0a]));
  assert.equal(result.kind, 'invalid_utf8');
  assert.equal(reader.pendingBytes, 0);
});

test('ACP_MAX_INBOUND_LINE_BYTES is a finite named cap', () => {
  assert.equal(ACP_MAX_INBOUND_LINE_BYTES, 8 * 1024 * 1024);
  assert.equal(Number.isFinite(ACP_MAX_INBOUND_LINE_BYTES), true);
});

test('encodeJsonRpcRequest preserves id 0 on the wire', () => {
  const encoded = encodeJsonRpcRequest(0, 'initialize', { protocolVersion: 1 });
  assert.match(encoded, /"id":0/);
  assert.equal(encodeJsonRpcError(0, -32601, 'Method not found').includes('"id":0'), true);
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
