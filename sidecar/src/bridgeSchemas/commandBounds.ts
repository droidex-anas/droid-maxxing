import { z } from 'zod';

import {
  sessionConfigurationSchema,
  type SessionConfiguration,
} from '../providers/providerIdentity.js';

export const MAX_BRIDGE_FRAME_BYTES = 1_048_576;
export const MAX_ID_BYTES = 256;
export const MAX_MODEL_ID_BYTES = 256;
export const MAX_LABEL_BYTES = 1_024;
export const MAX_PATH_BYTES = 16_384;
export const MAX_PROMPT_BYTES = 262_144;
export const MAX_BRIDGE_LIST_ITEMS = 64;
export const MAX_PROVIDER_OPTION_ENTRIES = 64;
export const MAX_SESSION_CONFIGURATION_BYTES = 65_536;
export const MAX_CHAT_TITLE_CHARS = 200;
export const MAX_HISTORY_PAGE_EVENTS = 1_600;
export const MAX_VIEWPORT_PX = 16_384;
export const MAX_DEVICE_SCALE_FACTOR = 4;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function utf8ByteString(
  maxBytes: number,
  options?: { minBytes?: number },
): z.ZodEffects<z.ZodString, string, string> {
  const minBytes = options?.minBytes ?? 0;
  return z.string().refine(
    (value) => {
      const bytes = Buffer.byteLength(value, 'utf8');
      return bytes >= minBytes && bytes <= maxBytes;
    },
    { message: 'string exceeds UTF-8 byte bound' },
  );
}

export const idStringSchema = utf8ByteString(MAX_ID_BYTES, { minBytes: 1 }).refine(
  (value) => value === value.trim(),
  'id must not have leading or trailing whitespace',
);

export const modelIdStringSchema = utf8ByteString(MAX_MODEL_ID_BYTES, { minBytes: 1 }).refine(
  (value) => value === value.trim(),
  'modelId must not have leading or trailing whitespace',
);

export const optionalIdStringSchema = idStringSchema.optional();
export const nullableIdStringSchema = z.union([idStringSchema, z.null()]);
export const labelStringSchema = utf8ByteString(MAX_LABEL_BYTES, { minBytes: 1 });
export const optionalLabelStringSchema = utf8ByteString(MAX_LABEL_BYTES).optional();
export const pathStringSchema = utf8ByteString(MAX_PATH_BYTES, { minBytes: 1 });
export const optionalPathStringSchema = utf8ByteString(MAX_PATH_BYTES, { minBytes: 1 }).optional();
export const promptStringSchema = utf8ByteString(MAX_PROMPT_BYTES);
export const nonemptyPromptStringSchema = utf8ByteString(MAX_PROMPT_BYTES, { minBytes: 1 });
export const titleStringSchema = z
  .string()
  .max(MAX_CHAT_TITLE_CHARS)
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_LABEL_BYTES,
    'title exceeds byte bound',
  );
export const optionalTitleStringSchema = titleStringSchema.optional();

export const finiteNumberSchema = z.number().finite();
export const finiteIntSchema = z.number().int().finite();
export const historyLimitSchema = finiteIntSchema.min(1).max(MAX_HISTORY_PAGE_EVENTS);
export const optionalHistoryLimitSchema = historyLimitSchema.optional();
export const compactionTokenLimitSchema = z.union([finiteNumberSchema.nonnegative(), z.null()]);
export const optionalCompactionTokenLimitSchema = compactionTokenLimitSchema.optional();

export const viewportSchema = z
  .object({
    width: finiteIntSchema.min(1).max(MAX_VIEWPORT_PX),
    height: finiteIntSchema.min(1).max(MAX_VIEWPORT_PX),
    deviceScaleFactor: finiteNumberSchema.positive().max(MAX_DEVICE_SCALE_FACTOR),
  })
  .strict();

export const boxSchema = z
  .object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    width: finiteNumberSchema.nonnegative(),
    height: finiteNumberSchema.nonnegative(),
  })
  .strict();

export const scrollPointSchema = z
  .object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
  })
  .strict();

export function boundedArray<T extends z.ZodTypeAny>(
  item: T,
  maxItems = MAX_BRIDGE_LIST_ITEMS,
): z.ZodArray<T> {
  return z.array(item).max(maxItems);
}

export function boundedStringRecord(
  value: z.ZodType<string>,
  maxEntries = MAX_BRIDGE_LIST_ITEMS,
  maxKeyBytes = MAX_LABEL_BYTES,
) {
  return z
    .record(utf8ByteString(maxKeyBytes, { minBytes: 1 }), value)
    .refine((record) => Object.keys(record).length <= maxEntries, {
      message: 'too many record entries',
    });
}

export const compactionTokenLimitPerModelSchema = z
  .record(utf8ByteString(MAX_MODEL_ID_BYTES, { minBytes: 1 }), finiteNumberSchema.nonnegative())
  .refine((record) => Object.keys(record).length <= MAX_BRIDGE_LIST_ITEMS, {
    message: 'too many per-model compaction limits',
  });

export const optionalCompactionTokenLimitPerModelSchema =
  compactionTokenLimitPerModelSchema.optional();

export const inboundSessionConfigurationSchema = sessionConfigurationSchema.superRefine(
  (config: SessionConfiguration, ctx) => {
    const options = config.providerSelection.options;
    const keys = Object.keys(options);
    if (keys.length > MAX_PROVIDER_OPTION_ENTRIES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'too many provider option entries',
      });
    }
    for (const key of keys) {
      if (Buffer.byteLength(key, 'utf8') > MAX_LABEL_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provider option key too long',
        });
      }
      const optionValue = options[key];
      if (
        typeof optionValue === 'string' &&
        Buffer.byteLength(optionValue, 'utf8') > MAX_PROMPT_BYTES
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provider option value too long',
        });
      }
    }
    if (Buffer.byteLength(JSON.stringify(config), 'utf8') > MAX_SESSION_CONFIGURATION_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session configuration too large',
      });
    }
  },
);

export function strictCommand<Type extends string, Shape extends z.ZodRawShape>(
  type: Type,
  shape: Shape,
) {
  return z.object({ type: z.literal(type), ...shape }).strict();
}
