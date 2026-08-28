import { z } from 'zod';

import { BACKGROUND_WORK_TIERS, INSTALL_CHANNELS, type ClientCommand } from '../protocol.js';
import { idStringSchema, MAX_LABEL_BYTES, strictCommand, utf8ByteString } from './commandBounds.js';

const installChannelSchema = z.enum(INSTALL_CHANNELS);
const backgroundWorkTierSchema = z.enum(BACKGROUND_WORK_TIERS);
const apiKeySchema = utf8ByteString(MAX_LABEL_BYTES, { minBytes: 1 }).optional();

export const desktopCommandSchemas = {
  connect: strictCommand('connect', {
    apiKey: apiKeySchema,
  }),
  'runtime.status': strictCommand('runtime.status', {}),
  'auth.status': strictCommand('auth.status', {}),
  'env.detect': strictCommand('env.detect', {}),
  'cli.install': strictCommand('cli.install', {
    channel: installChannelSchema,
  }),
  'cli.update': strictCommand('cli.update', {
    channel: installChannelSchema.optional(),
  }),
  'app.backgroundWork': strictCommand('app.backgroundWork', {
    tier: backgroundWorkTierSchema,
    focusedAppSessionId: z.union([idStringSchema, z.null()]).optional(),
  }),
} satisfies {
  [K in Extract<
    ClientCommand['type'],
    | 'connect'
    | 'runtime.status'
    | 'auth.status'
    | 'env.detect'
    | 'cli.install'
    | 'cli.update'
    | 'app.backgroundWork'
  >]: z.ZodType<Extract<ClientCommand, { type: K }>>;
};
