import type { RequestPermissionRequestParams } from '@factory/droid-sdk';

export type AutomationPermissionAutonomy = 'off' | 'low' | 'medium' | 'high';

/** The single MCP server name DROIDEX registers for automation tools. */
export const AUTOMATION_MCP_SERVER_NAME = 'droidex-automations';

// The registration guard and this policy must agree on what counts as the
// automation server, otherwise a configured server differing only by case or
// separator could register alongside it and inherit its trust.
export function normalizeMcpServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-');
}

const TOOL_TITLES: Record<string, string> = {
  automation_propose: 'Prepare DROIDEX automation',
  automation_list: 'View DROIDEX automations',
  automation_create: 'Create DROIDEX automation',
  automation_update: 'Update DROIDEX automation',
  automation_set_enabled: 'Pause or resume DROIDEX automation',
  automation_run_now: 'Run DROIDEX automation',
  automation_delete: 'Delete DROIDEX automation',
};

const AUTOMATION_TOOLS = new Set(Object.keys(TOOL_TITLES));

const ALWAYS_SAFE = new Set(['automation_propose', 'automation_list']);

const HIGH_AUTONOMY_SAFE = new Set([
  'automation_create',
  'automation_update',
  'automation_set_enabled',
  'automation_run_now',
]);

export function automationToolDisplayTitle(serverName: string, toolName: string): string | null {
  if (!isAutomationServer(serverName)) return null;
  const tool = automationToolName(toolName);
  return tool ? TOOL_TITLES[tool] : null;
}

export function shouldAutoApproveAutomationPermission(
  params: RequestPermissionRequestParams,
  autonomy: AutomationPermissionAutonomy | undefined,
): boolean {
  const target = automationPermissionTarget(params);
  return target
    ? shouldAutoApproveAutomationTool(target.serverName, target.toolName, autonomy)
    : false;
}

export function shouldAutoApproveAutomationTool(
  serverName: string,
  toolName: string,
  autonomy: AutomationPermissionAutonomy | undefined,
): boolean {
  if (!isAutomationServer(serverName)) return false;
  const tool = automationToolName(toolName);
  if (!tool) return false;
  if (ALWAYS_SAFE.has(tool)) return true;
  return autonomy === 'high' && HIGH_AUTONOMY_SAFE.has(tool);
}

/**
 * True when the request changes saved automation state, so an auto-approved
 * mutation can still be surfaced instead of executing invisibly.
 */
export function isAutomationMutationPermission(params: RequestPermissionRequestParams): boolean {
  const target = automationPermissionTarget(params);
  if (!target || !isAutomationServer(target.serverName)) return false;
  const tool = automationToolName(target.toolName);
  return Boolean(tool) && !ALWAYS_SAFE.has(tool);
}

export function automationPermissionTarget(
  params: RequestPermissionRequestParams,
): { serverName: string; toolName: string } | null {
  const raw = params as unknown as Record<string, unknown>;
  const toolUses = Array.isArray(raw.toolUses) ? (raw.toolUses as unknown[]) : [];
  const firstToolUse = recordValue(toolUses[0]);
  const details =
    (firstToolUse ? recordValue(firstToolUse.details) : null) ?? confirmationDetail(raw);
  if (stringValue(details.type) !== 'mcp_tool') return null;
  const rawToolName = stringValue(details.toolName);
  const explicitServerName = stringValue(details.serverName);
  const split = splitNamespacedTool(rawToolName);
  const serverName = explicitServerName || split.serverName;
  const toolName = split.toolName;
  return toolName ? { serverName, toolName } : null;
}

/**
 * The canonical automation tool name for a possibly namespaced tool name, or an
 * empty string when the value is not one of the automation tools.
 */
export function automationToolName(value: string): string {
  const tool = splitNamespacedTool(value.trim()).toolName.trim().toLowerCase();
  return AUTOMATION_TOOLS.has(tool) ? tool : '';
}

function isAutomationServer(serverName: string): boolean {
  return normalizeMcpServerName(serverName) === AUTOMATION_MCP_SERVER_NAME;
}

function splitNamespacedTool(value: string): { serverName: string; toolName: string } {
  if (value.includes('___')) {
    const marker = value.indexOf('___');
    return { serverName: value.slice(0, marker), toolName: value.slice(marker + 3) };
  }
  const mcpMatch = /^mcp__([^_].*?)__([^_].*)$/i.exec(value);
  if (mcpMatch) {
    const [, serverName, toolName] = mcpMatch;
    return { serverName, toolName };
  }
  return { serverName: '', toolName: value };
}

function confirmationDetail(raw: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(raw.confirmations)) {
    const first: unknown = raw.confirmations[0];
    const record = recordValue(first);
    if (record) return recordValue(record.confirmation) ?? record;
  }
  return recordValue(raw.confirmation) ?? {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
