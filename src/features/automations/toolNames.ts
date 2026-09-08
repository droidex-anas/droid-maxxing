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
  const result = parseToolResultObject(value);
  return result?.ok === true && typeof result.proposalId === 'string' ? result.proposalId : null;
}

/** Decode the JSON result or MCP text content emitted by the automation tools. */
export function parseToolResultObject(value: string): Record<string, unknown> | null {
  return toolResult(value, 0);
}

function toolResult(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 5) return null;
  if (typeof value === 'string') {
    try {
      return toolResult(JSON.parse(value) as unknown, depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = toolResult(item, depth + 1);
      if (result) return result;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ok === 'boolean' || typeof record.error === 'string') return record;
  if (record.type === 'text' && typeof record.text === 'string') {
    return toolResult(record.text, depth + 1) ?? { error: record.text };
  }
  return Array.isArray(record.content) ? toolResult(record.content, depth + 1) : null;
}
