// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d packages/effect-acp/src/protocol.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

export const ACP_JSONRPC_VERSION = '2.0' as const;

// T3 leaves inbound ACP lines unbounded. DROIDEX caps a single NDJSON object at
// the sidecar hard client buffer so a runaway peer cannot pin unbounded memory.
export const ACP_MAX_INBOUND_LINE_BYTES = 8 * 1024 * 1024;

export type JsonRpcId = string | number;

export type JsonRpcInbound =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'success'; id: JsonRpcId; result: unknown }
  | { kind: 'error'; id: JsonRpcId | null; error: JsonRpcErrorObject };

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcDecodeFailure = 'malformed_json' | 'invalid_message';

export type JsonRpcDecodeResult =
  | { ok: true; message: JsonRpcInbound }
  | { ok: false; failure: JsonRpcDecodeFailure };

export type NdjsonPushResult =
  | { kind: 'lines'; lines: string[] }
  | { kind: 'oversized' }
  | { kind: 'invalid_utf8' };

const jsonRpcErrorObjectSchema = z
  .object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();

const inboundEnvelopeSchema = z
  .object({
    jsonrpc: z.literal(ACP_JSONRPC_VERSION),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1).optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: jsonRpcErrorObjectSchema.optional(),
  })
  .passthrough();

export function jsonRpcIdKey(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${String(id)}` : `s:${id}`;
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

export function encodeJsonRpcRequest(id: JsonRpcId, method: string, params?: unknown): string {
  return encodeNdjson({
    jsonrpc: ACP_JSONRPC_VERSION,
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

export function encodeJsonRpcNotification(method: string, params?: unknown): string {
  return encodeNdjson({
    jsonrpc: ACP_JSONRPC_VERSION,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

export function encodeJsonRpcResult(id: JsonRpcId, result: unknown): string {
  return encodeNdjson({ jsonrpc: ACP_JSONRPC_VERSION, id, result });
}

export function encodeJsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): string {
  return encodeNdjson({
    jsonrpc: ACP_JSONRPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  });
}

export function encodeNdjson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function decodeJsonRpcLine(line: string): JsonRpcDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { ok: false, failure: 'malformed_json' };
  }
  return classifyJsonRpcMessage(parsed);
}

export function classifyJsonRpcMessage(value: unknown): JsonRpcDecodeResult {
  const envelope = inboundEnvelopeSchema.safeParse(value);
  if (!envelope.success || !isPlainObject(value)) {
    return { ok: false, failure: 'invalid_message' };
  }

  const record = value;
  const hasId = Object.prototype.hasOwnProperty.call(record, 'id');
  const hasResult = Object.prototype.hasOwnProperty.call(record, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(record, 'error');
  const method = envelope.data.method;
  const id = envelope.data.id;

  if (method !== undefined) {
    if (hasResult || hasError) {
      return { ok: false, failure: 'invalid_message' };
    }
    // `id: 0` is a valid JSON-RPC id. Presence must be tested with `hasId`,
    // never with a truthy check on the value.
    if (hasId && isJsonRpcId(id)) {
      return { ok: true, message: { kind: 'request', id, method, params: envelope.data.params } };
    }
    if (!hasId) {
      return { ok: true, message: { kind: 'notification', method, params: envelope.data.params } };
    }
    return { ok: false, failure: 'invalid_message' };
  }

  if (hasId && hasError && envelope.data.error && !hasResult) {
    return {
      ok: true,
      message: {
        kind: 'error',
        id: isJsonRpcId(id) || id === null ? id : null,
        error: {
          code: envelope.data.error.code,
          message: envelope.data.error.message,
          ...(envelope.data.error.data === undefined ? {} : { data: envelope.data.error.data }),
        },
      },
    };
  }

  if (hasId && hasResult && !hasError && isJsonRpcId(id)) {
    return { ok: true, message: { kind: 'success', id, result: envelope.data.result } };
  }

  return { ok: false, failure: 'invalid_message' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class NdjsonLineReader {
  #pending: Buffer = Buffer.alloc(0);
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #failed = false;

  constructor(private readonly maxLineBytes: number = ACP_MAX_INBOUND_LINE_BYTES) {}

  get pendingBytes(): number {
    return this.#pending.length;
  }

  push(chunk: Uint8Array): NdjsonPushResult {
    if (this.#failed) {
      return { kind: 'oversized' };
    }

    const lines: string[] = [];
    let pending = this.#pending;
    let offset = 0;

    while (offset <= chunk.byteLength) {
      const pendingNewline = pending.indexOf(0x0a);
      if (pendingNewline !== -1) {
        const lineBuffer = pending.subarray(0, pendingNewline);
        pending = pending.subarray(pendingNewline + 1);
        const decoded = this.#decodeLine(lineBuffer);
        if (decoded === undefined) {
          return { kind: 'invalid_utf8' };
        }
        lines.push(decoded);
        continue;
      }

      const newline = indexOfByte(chunk, 0x0a, offset);
      if (newline === -1) {
        const remaining = chunk.byteLength - offset;
        if (pending.length + remaining > this.maxLineBytes) {
          return this.#failOversized();
        }
        if (remaining > 0) {
          pending = concatBuffers(pending, chunk.subarray(offset));
        }
        this.#pending = pending;
        return { kind: 'lines', lines };
      }

      const piece = chunk.subarray(offset, newline);
      if (pending.length + piece.byteLength > this.maxLineBytes) {
        return this.#failOversized();
      }
      const lineBuffer = pending.length === 0 ? Buffer.from(piece) : concatBuffers(pending, piece);
      pending = Buffer.alloc(0);
      offset = newline + 1;
      const decoded = this.#decodeLine(lineBuffer);
      if (decoded === undefined) {
        return { kind: 'invalid_utf8' };
      }
      lines.push(decoded);
    }

    this.#pending = pending;
    return { kind: 'lines', lines };
  }

  finish(): NdjsonPushResult {
    if (this.#failed) {
      return { kind: 'oversized' };
    }
    if (this.#pending.length === 0) {
      return { kind: 'lines', lines: [] };
    }
    if (this.#pending.length > this.maxLineBytes) {
      return this.#failOversized();
    }
    const decoded = this.#decodeLine(this.#pending);
    this.#pending = Buffer.alloc(0);
    if (decoded === undefined) {
      return { kind: 'invalid_utf8' };
    }
    return { kind: 'lines', lines: [decoded] };
  }

  #decodeLine(lineBuffer: Buffer): string | undefined {
    const trimmed =
      lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d
        ? lineBuffer.subarray(0, lineBuffer.length - 1)
        : lineBuffer;
    try {
      return this.#decoder.decode(trimmed);
    } catch {
      this.#failed = true;
      this.#pending = Buffer.alloc(0);
      return undefined;
    }
  }

  #failOversized(): { kind: 'oversized' } {
    this.#failed = true;
    this.#pending = Buffer.alloc(0);
    return { kind: 'oversized' };
  }
}

function indexOfByte(chunk: Uint8Array, byte: number, start: number): number {
  for (let index = start; index < chunk.byteLength; index += 1) {
    if (chunk[index] === byte) {
      return index;
    }
  }
  return -1;
}

function concatBuffers(left: Buffer, right: Uint8Array): Buffer {
  return Buffer.concat([left, right]);
}
