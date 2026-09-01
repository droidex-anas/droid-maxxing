const AUTOMATION_TOOLS = [
  'automation_propose',
  'automation_create',
  'automation_list',
  'automation_update',
  'automation_set_enabled',
  'automation_run_now',
  'automation_delete',
] as const;

const AUTOMATION_SERVER_PREFIXES = ['droidex_automations', 'mcp_droidex_automations'] as const;

export function automationToolBaseName(name: string | undefined): string {
  if (!name) return '';
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (
    AUTOMATION_TOOLS.find((toolName) => matchesAutomationTool(normalized, toolName)) ?? normalized
  );
}

function matchesAutomationTool(normalized: string, toolName: string): boolean {
  if (normalized === toolName) return true;
  const suffix = `_${toolName}`;
  if (!normalized.endsWith(suffix)) return false;
  return (AUTOMATION_SERVER_PREFIXES as readonly string[]).includes(
    normalized.slice(0, -suffix.length),
  );
}

export function isAutomationProposalCall(event: { kind?: string; toolName?: string }): boolean {
  return (
    event.kind === 'tool_call' && automationToolBaseName(event.toolName) === 'automation_propose'
  );
}

export function automationProposalIdFromText(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = parseToolResultValue(value);
  const nested = proposalIdFromValue(parsed, 0);
  if (nested) return nested;

  // Last-resort extraction also handles JSON-encoded text nested inside an MCP
  // content array, where quotes are escaped in the outer serialization.
  const normalized = value.replace(/\\"/g, '"').replace(/\\'/g, "'");
  const match = /["']proposalId["']\s*:\s*["']([^"']+)["']/.exec(normalized);
  return match?.[1] ?? null;
}

export function parseToolResultObject(value: string): Record<string, unknown> | null {
  const parsed = parseToolResultValue(value);
  return findObject(parsed, 0);
}

function parseToolResultValue(value: string): unknown {
  const candidates = [value.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const firstBrace = value.indexOf('{');
  const lastBrace = value.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace)
    candidates.push(value.slice(firstBrace, lastBrace + 1));
  const firstBracket = value.indexOf('[');
  const lastBracket = value.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(value.slice(firstBracket, lastBracket + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return null;
}

function proposalIdFromValue(value: unknown, depth: number): string | null {
  if (depth > 5) return null;
  if (typeof value === 'string') {
    const parsed = parseToolResultValue(value);
    return parsed === null ? null : proposalIdFromValue(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = proposalIdFromValue(item, depth + 1);
      if (id) return id;
    }
    return null;
  }
  const record = objectValue(value);
  if (!record) return null;
  if (record.ok === true && typeof record.proposalId === 'string') return record.proposalId;
  for (const nested of Object.values(record)) {
    const id = proposalIdFromValue(nested, depth + 1);
    if (id) return id;
  }
  return null;
}

function findObject(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 5) return null;
  const direct = objectValue(value);
  if (direct) return recordResult(direct, depth);
  if (typeof value === 'string') {
    const parsed = parseToolResultValue(value);
    return parsed === null ? null : findObject(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function recordResult(
  record: Record<string, unknown>,
  depth: number,
): Record<string, unknown> | null {
  if (typeof record.error === 'string' || record.ok !== undefined) return record;
  // An MCP text block carries the real result inside `text`; the block itself is
  // never worth showing, so a plain message becomes the error.
  const text = textContent(record);
  if (text !== null) {
    const parsed = parseToolResultValue(text);
    const found = parsed === null ? null : findObject(parsed, depth + 1);
    if (found) return found;
    return text.trim() ? { error: text.trim() } : null;
  }
  for (const nested of Object.values(record)) {
    const found = findObject(nested, depth + 1);
    if (found) return found;
  }
  return record;
}

function textContent(record: Record<string, unknown>): string | null {
  return record.type === 'text' && typeof record.text === 'string' ? record.text : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
