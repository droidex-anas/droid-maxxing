import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import type { ServerEvent } from '../protocol.js';
import { createRemoteCertificate } from './certificate.js';
import { RemoteHost } from './host.js';
import { authorize, digest, failure, json, matches, readJSON } from './http.js';
import { RemoteError, record, text, type RemoteEvent, type RemoteRuntime } from './types.js';

interface PendingPair {
  id: string;
  name: string;
  finish(allow: boolean): void;
}

export class RemoteServer {
  readonly id = randomUUID();
  readonly name = hostname();
  readonly host: RemoteHost;
  private server?: Server;
  private address = '';
  private fingerprint = '';
  private ticket = randomBytes(32).toString('hex');
  private ticketExpiresAt = Date.now() + 180_000;
  private usedTicket = false;
  private attempts = 0;
  private tokenHash?: Buffer;
  private device?: { id: string; name: string };
  private pending?: PendingPair;
  private closed = false;
  private closing?: Promise<void>;
  private streams = new Set<ServerResponse>();
  private dirty = new Map<string, RemoteEvent>();
  private flushTimer?: NodeJS.Timeout;

  constructor(readonly workspace: string, runtime: RemoteRuntime, private readonly certificateFactory = createRemoteCertificate) {
    this.host = new RemoteHost(workspace, runtime, (event) => this.enqueue(event));
  }

  async start(bindAddress: string): Promise<void> {
    const certificate = await this.certificateFactory(bindAddress);
    if (this.closed) throw new RemoteError(410, 'Connection setup was cancelled.');
    this.fingerprint = certificate.fingerprint;
    this.server = createServer({ key: certificate.key, cert: certificate.cert, minVersion: 'TLSv1.2', maxHeaderSize: 8_192 }, (request, response) => {
      void (async () => {
        if (this.closed || request.headers.origin) throw new RemoteError(403, 'Connection is unavailable.');
        const url = new URL(request.url || '/', 'https://localhost');
        const route = `${request.method} ${url.pathname}`;
        if (route === 'POST /pair') {
          const body = record(await readJSON(request));
          if (++this.attempts > 20 || this.usedTicket || Date.now() > this.ticketExpiresAt || !matches(text(body.ticket, 'Pairing ticket', 64), digest(this.ticket))) throw new RemoteError(403, 'This pairing code has expired or was already used. Generate a new code on your computer.');
          this.usedTicket = true;
          const name = text(body.name, 'Device name', 80);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => finish(false), 90_000);
            const finish = (allow: boolean) => {
              clearTimeout(timer);
              response.off('close', disconnected);
              this.pending = undefined;
              if (!response.destroyed) {
                if (allow && !this.closed) {
                  const token = randomBytes(32).toString('hex');
                  this.tokenHash = digest(`Bearer ${token}`);
                  this.device = { id: randomUUID(), name };
                  json(response, 200, { token, computerId: this.id, computerName: this.name, workspace: basename(this.workspace) });
                } else json(response, 403, { error: 'Pairing was declined, cancelled, or timed out. Generate a new code on the computer.' });
              }
              resolve();
            };
            const disconnected = () => finish(false);
            this.pending = { id: randomUUID(), name, finish };
            response.once('close', disconnected);
          });
          return;
        }
        authorize(request, this.tokenHash);
        if (route === 'GET /bootstrap') {
          await this.host.refreshCatalog();
          json(response, 200, { version: 1, computerId: this.id, computerName: this.name, workspace: basename(this.workspace), models: this.host.models, sessions: this.host.snapshot() });
        } else if (route === 'GET /events') {
          this.openStream(response);
        } else if (route === 'POST /turn') {
          this.host.turn(await readJSON(request));
          json(response, 202, { accepted: true });
        } else {
          const match = /^\/sessions\/([0-9a-f-]+)\/(stop|approval|answer|remove)$/.exec(url.pathname);
          if (request.method !== 'POST' || !match) throw new RemoteError(404, 'Unknown remote operation.');
          const [, id, operation] = match;
          if (operation === 'stop') await this.host.interrupt(id!);
          if (operation === 'approval') await this.host.approve(id!, await readJSON(request));
          if (operation === 'answer') await this.host.answer(id!, await readJSON(request));
          if (operation === 'remove') await this.host.remove(id!);
          json(response, 200, { accepted: true });
        }
      })().catch((error: unknown) => failure(response, error));
    });
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, bindAddress, resolve);
    });
    const endpoint = this.server.address();
    if (!endpoint || typeof endpoint === 'string') throw new Error('The remote listener did not open.');
    this.address = `https://${bindAddress}:${endpoint.port}`;
    await this.host.refreshCatalog();
  }

  observe(event: ServerEvent): void { this.host.observe(event); }

  status() {
    const code = this.usedTicket ? undefined : 'DX1.' + Buffer.from(JSON.stringify({
      version: 1, address: this.address, fingerprint: this.fingerprint, ticket: this.ticket,
    })).toString('base64url');
    return {
      enabled: !this.closed, computerName: this.name, workspace: this.workspace,
      address: this.address, code, expiresAt: this.ticketExpiresAt,
      pending: this.pending ? { id: this.pending.id, name: this.pending.name } : undefined,
      device: this.device, models: this.host.models.length,
    };
  }

  approve(id: string, allow: boolean): void {
    if (this.pending?.id !== id) throw new RemoteError(409, 'That pairing request is no longer waiting.');
    this.pending.finish(allow);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.tokenHash = undefined;
    this.pending?.finish(false);
    clearTimeout(this.flushTimer);
    this.dirty.clear();
    for (const response of this.streams) response.destroy();
    this.streams.clear();
    const closed = this.server ? new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
      this.server!.closeAllConnections();
    }) : Promise.resolve();
    this.closing = Promise.all([closed, this.host.close()]).then(() => undefined);
    return this.closing;
  }

  private enqueue(event: RemoteEvent): void {
    if (this.closed) return;
    const key = event.type === 'session' ? event.session.id : event.type === 'removed' ? event.id : event.type;
    this.dirty.set(key, event);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      for (const update of this.dirty.values()) {
        const line = JSON.stringify(update) + '\n';
        for (const response of this.streams) this.write(response, line);
      }
      this.dirty.clear();
    }, 60);
  }

  private openStream(response: ServerResponse): void {
    if (this.streams.size >= 2) throw new RemoteError(429, 'Too many active phone connections.');
    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    this.streams.add(response);
    this.write(response, JSON.stringify({ type: 'snapshot', sessions: this.host.snapshot() }) + '\n');
    const timer = setInterval(() => this.write(response, '{"type":"heartbeat"}\n'), 15_000);
    timer.unref();
    response.once('close', () => { clearInterval(timer); this.streams.delete(response); });
  }

  private write(response: ServerResponse, line: string): void {
    // Fail a slow consumer rather than accumulating an unbounded transcript queue.
    if (response.destroyed || response.writableLength + Buffer.byteLength(line) > 8 * 1024 * 1024) {
      response.destroy(); this.streams.delete(response); return;
    }
    response.write(line);
  }
}
