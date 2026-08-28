export const REDACTED = '[REDACTED]';

export type SanitizedLogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SanitizedLogValue[]
  | { [key: string]: SanitizedLogValue | undefined };

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(api[-_]?key|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|bridge[-_]?token|cookie|password|secret|token|credential[-_]?home|credentials|raw[-_]?account|account[-_]?payload)($|[_-])/i;

const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ENV_SECRET_ASSIGNMENT_PATTERN =
  /\b(FACTORY_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|CURSOR_API_KEY|CLAUDE_API_KEY|BRIDGE_TOKEN|AUTH_TOKEN|API_KEY|PASSWORD|SECRET|TOKEN)=([^\s"'`]+)/gi;
const TOKEN_SHAPE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|fac_(?:live|test)_[A-Za-z0-9_-]{8,})\b/g;
const CREDENTIAL_HOME_PATTERN =
  /(?:(?:\/(?:Users|home)\/[^/\s]+|~)\/\.(?:claude|codex|factory|cursor|grok|droid|config\/gcloud)(?:\/[^\s"'`]*)?)/gi;
const RAW_ACCOUNT_JSON_PATTERN = /\{[^{}]*"(?:accountId|account_id|email|rawAccount)"[^{}]*\}/g;

function shouldRedactKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`)
    .replace(ENV_SECRET_ASSIGNMENT_PATTERN, `$1=${REDACTED}`)
    .replace(TOKEN_SHAPE_PATTERN, REDACTED)
    .replace(CREDENTIAL_HOME_PATTERN, REDACTED)
    .replace(RAW_ACCOUNT_JSON_PATTERN, REDACTED);
}

export function sanitizeForLog(value: unknown, seen = new WeakSet<object>()): SanitizedLogValue {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined,
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => sanitizeForLog(entry, seen));
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  const sanitized: { [key: string]: SanitizedLogValue | undefined } = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = shouldRedactKey(key) ? REDACTED : sanitizeForLog(entry, seen);
  }
  seen.delete(value);
  return sanitized;
}
