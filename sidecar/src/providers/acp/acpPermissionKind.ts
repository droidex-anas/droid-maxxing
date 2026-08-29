import type { PermissionKind } from '../../protocol.js';

const ACP_TOOL_KIND_TO_PERMISSION = {
  execute: 'exec',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  create: 'create',
  apply_patch: 'apply_patch',
  mcp: 'mcp',
  spec: 'spec',
  mission_plan: 'mission_plan',
} as const satisfies Record<string, PermissionKind>;

function isMappedAcpToolKind(kind: string): kind is keyof typeof ACP_TOOL_KIND_TO_PERMISSION {
  return Object.prototype.hasOwnProperty.call(ACP_TOOL_KIND_TO_PERMISSION, kind);
}

export function permissionKindFromAcpToolKind(kind: string | undefined): PermissionKind {
  if (kind === undefined || !isMappedAcpToolKind(kind)) {
    return 'other';
  }
  return ACP_TOOL_KIND_TO_PERMISSION[kind];
}
