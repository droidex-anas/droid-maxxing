import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RemoteError } from './types.js';

export function digest(value: string): Buffer { return createHash('sha256').update(value).digest(); }
export function matches(value: string, expected: Buffer): boolean { return timingSafeEqual(digest(value), expected); }

export function authorize(request: IncomingMessage, expected?: Buffer): void {
  if (!expected || request.headers.origin || !matches(request.headers.authorization || '', expected)) {
    throw new RemoteError(401, 'This connection is not authorized. Pair with the computer again.');
  }
}

export async function readJSON(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new RemoteError(415, 'Send application/json.');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 32 * 1024) throw new RemoteError(413, 'Request is too large.');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RemoteError(400, 'Invalid JSON.'); }
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'",
  });
  response.end(JSON.stringify(value));
}

export function failure(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return; }
  const status = error instanceof RemoteError ? error.status : 500;
  json(response, status, { error: error instanceof Error ? error.message : 'The desktop request failed.' });
}
