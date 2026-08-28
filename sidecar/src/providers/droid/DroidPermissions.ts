import type { RequestPermissionRequestParams } from '@factory/droid-sdk';

import type { PermissionKind } from '../../protocol.js';

const PERMISSION_KIND: Record<string, PermissionKind> = {
  edit: 'edit',
  exec: 'exec',
  create: 'create',
  apply_patch: 'apply_patch',
  mcp_tool: 'mcp',
  exit_spec_mode: 'spec',
};

interface ConfirmationDetail {
  type?: string;
  [k: string]: unknown;
}

function primaryConfirmation(params: RequestPermissionRequestParams): ConfirmationDetail {
  const raw = params as unknown as Record<string, unknown>;
  const toolUses = raw.toolUses as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(toolUses) && toolUses.length > 0) {
    const details = toolUses[0]?.details as ConfirmationDetail | undefined;
    if (details) return details;
  }
  const list = raw.confirmations as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(list) && list.length > 0) {
    const item = list[0];
    if (item) {
      return (item.confirmation as ConfirmationDetail) ?? (item as ConfirmationDetail);
    }
  }
  return (raw.confirmation as ConfirmationDetail) ?? {};
}

function primaryToolInput(params: RequestPermissionRequestParams): Record<string, unknown> {
  const raw = params as unknown as Record<string, unknown>;
  const toolUses = raw.toolUses as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(toolUses) && toolUses.length > 0) {
    const toolUse = toolUses[0]?.toolUse as Record<string, unknown> | undefined;
    const input = toolUse?.input;
    if (input && typeof input === 'object') return input as Record<string, unknown>;
  }
  return {};
}

function mcpToolDetail(detail: ConfirmationDetail, input: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    if (rendered === undefined || rendered === '' || rendered === '{}') continue;
    lines.push(`${key}: ${rendered}`);
  }
  if (detail.impactLevel) lines.push(`Impact: ${detail.impactLevel}`);
  return lines.join('\n');
}

export interface DroidPermissionView {
  kind: PermissionKind;
  title: string;
  detail: string;
  plan?: string;
  options?: string[];
}

export function classifyPermission(params: RequestPermissionRequestParams): DroidPermissionView {
  const confirmation = primaryConfirmation(params);
  const type = String(confirmation.type ?? 'other');
  let title = 'Permission required';
  let detail = '';
  let plan: string | undefined;
  let options: string[] | undefined;
  let kind: PermissionKind = PERMISSION_KIND[type] ?? 'other';

  switch (type) {
    case 'exit_spec_mode':
      title = (confirmation.title as string) ?? 'Plan ready for review';
      plan = (confirmation.plan as string) ?? '';
      detail = plan;
      options = Array.isArray(confirmation.optionNames)
        ? (confirmation.optionNames as string[])
        : undefined;
      kind = 'spec';
      break;
    case 'propose_mission':
      title = (confirmation.title as string) ?? 'Mission plan proposed';
      plan = (confirmation.proposal as string) ?? '';
      detail = plan;
      kind = 'mission_plan';
      break;
    case 'start_mission_run':
      title = 'Start mission run';
      detail = `Running missions: ${confirmation.runningMissionCount ?? 0}`;
      kind = 'other';
      break;
    case 'exec': {
      title = 'Run command';
      const fullCommand =
        typeof confirmation.fullCommand === 'string' ? confirmation.fullCommand : '';
      const command = typeof confirmation.command === 'string' ? confirmation.command : '';
      detail = fullCommand || command || JSON.stringify(confirmation);
      break;
    }
    case 'edit':
    case 'create':
      title = type === 'create' ? 'Create file' : 'Edit file';
      detail = (confirmation.filePath as string) ?? (confirmation.fileName as string) ?? '';
      break;
    case 'apply_patch':
      title = 'Apply patch';
      detail = (confirmation.fileName as string) ?? (confirmation.filePath as string) ?? '';
      break;
    case 'mcp_tool': {
      const rawTool = typeof confirmation.toolName === 'string' ? confirmation.toolName : '';
      const [splitServer, splitTool] = rawTool.includes('___')
        ? [rawTool.slice(0, rawTool.indexOf('___')), rawTool.slice(rawTool.indexOf('___') + 3)]
        : ['', rawTool];
      const serverName =
        typeof confirmation.serverName === 'string' && confirmation.serverName
          ? confirmation.serverName
          : splitServer;
      const toolName = splitTool;
      title = toolName
        ? serverName
          ? `${serverName} · ${toolName}`
          : toolName
        : serverName
          ? `${serverName} tool`
          : 'External tool';
      detail = mcpToolDetail(confirmation, primaryToolInput(params));
      break;
    }
    default:
      detail = JSON.stringify(confirmation);
  }

  return { kind, title, detail, plan, options };
}

export function confirmationType(params: RequestPermissionRequestParams): string {
  return String(primaryConfirmation(params).type ?? 'other');
}

export function permissionSignature(params: RequestPermissionRequestParams): string {
  const confirmation = primaryConfirmation(params);
  const type = String(confirmation.type ?? 'other');
  switch (type) {
    case 'exec': {
      const fullCommand =
        typeof confirmation.fullCommand === 'string' ? confirmation.fullCommand : '';
      const command = typeof confirmation.command === 'string' ? confirmation.command : '';
      return `exec::${fullCommand || command}`;
    }
    case 'mcp_tool':
      return `mcp::${String(confirmation.serverName ?? '')}::${String(confirmation.toolName ?? '')}`;
    case 'edit':
    case 'create':
    case 'apply_patch': {
      const path =
        typeof confirmation.filePath === 'string' && confirmation.filePath
          ? confirmation.filePath
          : typeof confirmation.fileName === 'string' && confirmation.fileName
            ? confirmation.fileName
            : '';
      return path ? `${type}::${path}` : '';
    }
    default:
      return '';
  }
}
