import type { RawData } from 'ws';
import type { z } from 'zod';

import type { ClientCommand } from './protocol.js';
import { browserCommandSchemas } from './bridgeSchemas/browserCommands.js';
import { MAX_BRIDGE_FRAME_BYTES } from './bridgeSchemas/commandBounds.js';
import { desktopCommandSchemas } from './bridgeSchemas/desktopCommands.js';
import { mcpCommandSchemas } from './bridgeSchemas/mcpCommands.js';
import { sessionCommandSchemas } from './bridgeSchemas/sessionCommands.js';

export { MAX_BRIDGE_FRAME_BYTES };

export type BridgeCommandParseResult =
  | { ok: true; command: ClientCommand }
  | {
      ok: false;
      code: 'invalid_bridge_frame' | 'bridge_frame_too_large';
      message: string;
      closeCode?: 1003 | 1009;
    };

type CommandSchemaMap = {
  [K in ClientCommand['type']]: z.ZodType<Extract<ClientCommand, { type: K }>>;
};

type Exclusive<A, B> =
  Extract<keyof A, keyof B> extends never
    ? true
    : ['overlapping command families', Extract<keyof A, keyof B>];

type ExclusiveFamilies = [
  Exclusive<typeof sessionCommandSchemas, typeof browserCommandSchemas>,
  Exclusive<typeof sessionCommandSchemas, typeof mcpCommandSchemas>,
  Exclusive<typeof sessionCommandSchemas, typeof desktopCommandSchemas>,
  Exclusive<typeof browserCommandSchemas, typeof mcpCommandSchemas>,
  Exclusive<typeof browserCommandSchemas, typeof desktopCommandSchemas>,
  Exclusive<typeof mcpCommandSchemas, typeof desktopCommandSchemas>,
];

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const commandSchemaByType = {
  ...sessionCommandSchemas,
  ...browserCommandSchemas,
  ...mcpCommandSchemas,
  ...desktopCommandSchemas,
} satisfies CommandSchemaMap;

type CoveredType = keyof typeof commandSchemaByType;
type MissingCommand = Exclude<ClientCommand['type'], CoveredType>;
type ExtraCommand = Exclude<CoveredType, ClientCommand['type']>;
type ExhaustiveCommands = [
  MissingCommand extends never ? true : MissingCommand,
  ExtraCommand extends never ? true : ExtraCommand,
  ExclusiveFamilies,
];
const _exhaustiveCommands: ExhaustiveCommands = [true, true, [true, true, true, true, true, true]];
void _exhaustiveCommands;

export function parseBridgeCommand(raw: RawData, isBinary: boolean): BridgeCommandParseResult {
  if (isBinary) {
    // Binary frames close with 1003.
    return unsupportedData('Binary bridge frames are not supported');
  }

  const byteLength = rawByteLength(raw);
  if (byteLength > MAX_BRIDGE_FRAME_BYTES) {
    // Oversized text frames close with 1009.
    return {
      ok: false,
      code: 'bridge_frame_too_large',
      message: 'Bridge frame exceeds the maximum size',
      closeCode: 1009,
    };
  }

  let text: string;
  try {
    text = utf8Decoder.decode(rawBytes(raw));
  } catch {
    return unsupportedData('Bridge frame is not valid UTF-8');
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidFrame();
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidFrame();
  }

  const typeValue = Reflect.get(value, 'type');
  if (typeof typeValue !== 'string' || !isClientCommandType(typeValue)) {
    return invalidFrame();
  }

  const parsed = commandSchemaByType[typeValue].safeParse(value);
  if (!parsed.success) {
    return invalidFrame();
  }

  return { ok: true, command: parsed.data };
}

function isClientCommandType(value: string): value is ClientCommand['type'] {
  return Object.prototype.hasOwnProperty.call(commandSchemaByType, value);
}

function invalidFrame(): BridgeCommandParseResult {
  return {
    ok: false,
    code: 'invalid_bridge_frame',
    message: 'Invalid bridge command',
  };
}

function unsupportedData(message: string): BridgeCommandParseResult {
  return {
    ok: false,
    code: 'invalid_bridge_frame',
    message,
    closeCode: 1003,
  };
}

function rawByteLength(raw: RawData): number {
  // Measure the raw frame before any UTF-8 or JSON decoding.
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  let total = 0;
  for (const chunk of raw) total += chunk.byteLength;
  return total;
}

function rawBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw.length === 1) {
    const only = raw[0];
    return only ?? new Uint8Array();
  }
  return Buffer.concat(raw);
}
