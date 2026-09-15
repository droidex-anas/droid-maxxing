import { strict as assert } from 'node:assert';
import { request as httpsRequest } from 'node:https';
import { test } from 'node:test';
import { createRemoteCertificate } from './certificate.js';
import { RemoteServer } from './server.js';
import { parseDiff } from './diff.js';
import type { RemoteRuntime } from './types.js';

const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test('encrypted pairing requires desktop approval, consumes the ticket, and enforces the narrow API', async (context) => {
  const certificate = await createRemoteCertificate('127.0.0.1');
  let server: RemoteServer;
  const runtime: RemoteRuntime = { async handle(command) {
    if (command.type === 'catalog.models') server.observe({ type: 'catalog.updated', catalog: 'models', items: [] });
  } };
  server = new RemoteServer('/test/workspace', runtime, async () => certificate);
  await server.start('127.0.0.1');
  context.after(() => server.close());
  const status = server.status();
  assert.ok(status.code);
  const code = JSON.parse(Buffer.from(status.code.slice(4), 'base64url').toString()) as { ticket: string; fingerprint: string };
  assert.equal(code.fingerprint, certificate.fingerprint);

  function request(path: string, body?: unknown, token?: string, origin?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const request = httpsRequest(status.address + path, {
        ca: certificate.cert, // Trust only this test certificate, with normal hostname validation enabled.
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
      }, (response) => {
        let value = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { value += chunk; });
        response.on('end', () => resolve({ status: response.statusCode || 0, body: JSON.parse(value) }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  assert.equal((await request('/bootstrap')).status, 401);
  const paired = request('/pair', { ticket: code.ticket, name: 'Test phone' });
  for (let attempt = 0; !server.status().pending && attempt < 100; attempt += 1) await wait();
  const pending = server.status().pending;
  assert.ok(pending);
  assert.equal(server.status().device, undefined);
  server.approve(pending.id, true);
  const result = await paired;
  assert.equal(result.status, 200);
  const token = result.body.token;
  assert.equal(typeof token, 'string');
  assert.equal((await request('/bootstrap', undefined, String(token))).status, 200);
  assert.equal((await request('/bootstrap', undefined, String(token), 'https://untrusted.example')).status, 403);
  assert.equal((await request('/pair', { ticket: code.ticket, name: 'Second phone' })).status, 403);
  assert.equal((await request('/command', { type: 'cli.install', channel: 'script' }, String(token))).status, 404);
  assert.equal((await request('/turn', { modelId: 'invented' }, String(token))).status, 400);
  assert.equal(JSON.stringify(server.status()).includes(String(token)), false);
  await server.close(); await server.close();
});

test('diff parser keeps additions/deletions separate and does not mistake headers for edits', () => {
  const changes = parseDiff('diff --git a/file.swift b/file.swift\n--- a/file.swift\n+++ b/file.swift\n@@ -1 +1 @@\n-old\n+new\n context\n');
  assert.deepEqual(changes, [{ path: 'file.swift', lines: [
    { kind: 'deletion', text: 'old' }, { kind: 'addition', text: 'new' }, { kind: 'context', text: 'context' },
  ] }]);
});

test('an expired or declined pairing ticket grants no credential', async (context) => {
  const certificate = await createRemoteCertificate('127.0.0.1');
  let server: RemoteServer;
  const runtime: RemoteRuntime = { async handle(command) {
    if (command.type === 'catalog.models') server.observe({ type: 'catalog.updated', catalog: 'models', items: [] });
  } };
  server = new RemoteServer('/test/workspace', runtime, async () => certificate);
  await server.start('127.0.0.1');
  context.after(() => server.close());
  const status = server.status();
  const code = JSON.parse(Buffer.from(status.code!.slice(4), 'base64url').toString()) as { ticket: string };
  const pair = () => new Promise<number>((resolve, reject) => {
    const request = httpsRequest(status.address + '/pair', { ca: certificate.cert, method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode || 0));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ ticket: code.ticket, name: 'Test phone' }));
  });
  const clock = context.mock.method(Date, 'now', () => status.expiresAt + 1);
  assert.equal(await pair(), 403);
  assert.equal(server.status().pending, undefined);
  clock.mock.restore();
  const declined = pair();
  for (let index = 0; !server.status().pending && index < 100; index += 1) await wait();
  server.approve(server.status().pending!.id, false);
  assert.equal(await declined, 403);
  assert.equal(server.status().device, undefined);
  assert.equal(await pair(), 403);
});

test('HTTPS NDJSON streams real host state and reconnects with an authoritative snapshot', async (context) => {
  const { randomUUID } = await import('node:crypto');
  const certificate = await createRemoteCertificate('127.0.0.1');
  let server: RemoteServer;
  const runtime: RemoteRuntime = { async handle(command) {
    if (command.type === 'catalog.models') server.observe({ type: 'catalog.updated', catalog: 'models', items: [{ id: 'test-model', displayName: 'Test model', isCustom: false }] });
    if (command.type === 'session.create') {
      // Only the provider runtime is faked: the HTTPS listener, approval, command route,
      // RemoteHost projection, serialization, buffering and reconnect are real.
      const summary = { appSessionId: randomUUID(), title: command.title, cwd: command.cwd, modelId: command.modelId, interactionMode: 'auto', streaming: true, phase: 'running' } as import('../protocol.js').SessionSummary;
      server.observe({ type: 'session.created', clientRef: command.clientRef, session: { ...summary, streaming: false } });
      server.observe({ type: 'session.updated', session: summary });
      server.observe({ type: 'event.appended', event: { id: randomUUID(), appSessionId: summary.appSessionId, sourceSessionId: summary.appSessionId, role: 'primary', ts: Date.now(), kind: 'text', text: 'Streamed through HTTPS.' } });
      server.observe({ type: 'session.updated', session: { ...summary, streaming: false, phase: 'completed' } });
    }
  } };
  server = new RemoteServer('/test/workspace', runtime, async () => certificate);
  await server.start('127.0.0.1');
  context.after(() => server.close());
  const status = server.status();
  const code = JSON.parse(Buffer.from(status.code!.slice(4), 'base64url').toString()) as { ticket: string };
  async function post(path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const request = httpsRequest(status.address + path, { ca: certificate.cert, method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
        let data = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => { try { assert.ok(response.statusCode && response.statusCode < 300); resolve(JSON.parse(data)); } catch (error) { reject(error); } });
      });
      request.on('error', reject); request.end(JSON.stringify(body));
    });
  }
  const pairing = post('/pair', { ticket: code.ticket, name: 'Stream test' });
  for (let index = 0; !server.status().pending && index < 100; index += 1) await wait();
  server.approve(server.status().pending!.id, true);
  const token = String((await pairing).token);
  async function event(type: 'snapshot' | 'session') {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = httpsRequest(status.address + '/events', { ca: certificate.cert, headers: { authorization: `Bearer ${token}` } }, (response) => {
        let buffer = ''; response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          while (buffer.includes('\n')) {
            const end = buffer.indexOf('\n');
            const value = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
            buffer = buffer.slice(end + 1);
            if (value.type === type) { resolve(value); request.destroy(); return; }
          }
        });
        response.on('error', reject);
      });
      request.setTimeout(3_000, () => { request.destroy(); reject(new Error('No stream event arrived.')); });
      request.on('error', reject); request.end();
    });
  }
  const initial = await event('snapshot');
  assert.deepEqual(initial.sessions, []);
  const live = event('session');
  await post('/turn', { id: randomUUID(), requestId: randomUUID(), prompt: 'Test transport', modelId: 'test-model', mode: 'auto' }, token);
  const update = await live;
  const session = update.session as { phase: string; messages: { text: string }[] };
  assert.equal(session.phase, 'completed');
  assert.equal(session.messages.at(-1)?.text, 'Streamed through HTTPS.');
  const restored = await event('snapshot');
  assert.equal((restored.sessions as typeof session[])[0]?.messages.at(-1)?.text, 'Streamed through HTTPS.');
});
