import { z } from 'zod';

import { MCP_HTTP_SERVER_TYPES, type McpClientCommand } from '../mcpProtocol.js';
import type { ClientCommand } from '../protocol.js';
import {
  boundedArray,
  boundedStringRecord,
  idStringSchema,
  labelStringSchema,
  MAX_PATH_BYTES,
  optionalPathStringSchema,
  pathStringSchema,
  strictCommand,
  utf8ByteString,
} from './commandBounds.js';

const httpServerSchema = z
  .object({
    name: labelStringSchema,
    serverType: z.enum(MCP_HTTP_SERVER_TYPES),
    url: utf8ByteString(MAX_PATH_BYTES, { minBytes: 1 }),
    headers: boundedStringRecord(utf8ByteString(MAX_PATH_BYTES)).optional(),
  })
  .strict();

const stdioServerSchema = z
  .object({
    name: labelStringSchema,
    serverType: z.literal('stdio'),
    command: pathStringSchema,
    args: boundedArray(utf8ByteString(MAX_PATH_BYTES)).optional(),
    env: boundedStringRecord(utf8ByteString(MAX_PATH_BYTES)).optional(),
  })
  .strict();

const mcpServerInputSchema = z.discriminatedUnion('serverType', [
  httpServerSchema,
  stdioServerSchema,
]);

export const mcpCommandSchemas = {
  'mcp.list': strictCommand('mcp.list', {
    requestId: idStringSchema,
    cwd: optionalPathStringSchema,
  }),
  'mcp.add': strictCommand('mcp.add', {
    requestId: idStringSchema,
    cwd: optionalPathStringSchema,
    server: mcpServerInputSchema,
  }),
  'mcp.remove': strictCommand('mcp.remove', {
    requestId: idStringSchema,
    cwd: optionalPathStringSchema,
    serverName: labelStringSchema,
  }),
  'mcp.toggle': strictCommand('mcp.toggle', {
    requestId: idStringSchema,
    cwd: optionalPathStringSchema,
    serverName: labelStringSchema,
    enabled: z.boolean(),
  }),
  'mcp.authenticate': strictCommand('mcp.authenticate', {
    requestId: idStringSchema,
    cwd: optionalPathStringSchema,
    serverName: labelStringSchema,
  }),
} satisfies {
  [K in McpClientCommand['type']]: z.ZodType<Extract<ClientCommand, { type: K }>>;
};
