// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/CursorAdapter.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

import type { Autonomy, PermissionKind } from '../../protocol.js';
import type { ProviderApprovalDecision } from '../providerTypes.js';

export const CURSOR_ACP_KIND_APPROVAL_TABLE = [
  { acpKind: 'execute', permissionKind: 'exec', approvalClass: 'command' },
  { acpKind: 'read', permissionKind: 'other', approvalClass: 'file_read' },
  { acpKind: 'edit', permissionKind: 'edit', approvalClass: 'file_change' },
  { acpKind: 'delete', permissionKind: 'edit', approvalClass: 'file_change' },
  { acpKind: 'move', permissionKind: 'edit', approvalClass: 'file_change' },
] as const satisfies readonly {
  acpKind: string;
  permissionKind: PermissionKind;
  approvalClass: 'command' | 'file_read' | 'file_change';
}[];

export const CURSOR_ACP_KIND_FALLBACK_PERMISSION_KIND = 'other' as const satisfies PermissionKind;
export const CURSOR_ACP_KIND_FALLBACK_APPROVAL_CLASS = 'dynamic_tool' as const;

export const CURSOR_AUTONOMY_TABLE = [
  { autonomy: 'off', autoApproveAcpKinds: [] },
  { autonomy: 'low', autoApproveAcpKinds: ['read'] },
  { autonomy: 'medium', autoApproveAcpKinds: ['read', 'search', 'fetch'] },
  { autonomy: 'high', autoApproveAcpKinds: 'all' },
] as const satisfies readonly {
  autonomy: Autonomy;
  autoApproveAcpKinds: readonly string[] | 'all';
}[];

export const CURSOR_DECISION_TO_OPTION_KIND = [
  { decision: 'allow_once', optionKind: 'allow_once' },
  { decision: 'allow_session', optionKind: 'allow_always' },
  { decision: 'deny', optionKind: 'reject_once' },
] as const;

export const CURSOR_PERMISSION_CANCELLED_RESULT = {
  outcome: { outcome: 'cancelled' },
} as const;

export interface CursorAcpPermissionOption {
  optionId: string;
  name?: string;
  kind: string;
}

export interface CursorParsedPermissionRequest {
  toolCallId: string;
  acpKind: string;
  title: string;
  detail: string;
  permissionKind: PermissionKind;
  approvalClass: 'command' | 'file_read' | 'file_change' | 'dynamic_tool';
  options: readonly CursorAcpPermissionOption[];
}

const permissionOptionSchema = z
  .object({
    optionId: z.string().min(1),
    name: z.string().optional(),
    kind: z.string().min(1),
  })
  .passthrough();

const permissionToolCallSchema = z
  .object({
    toolCallId: z.string().min(1),
    title: z.string().optional(),
    kind: z.string().optional(),
    rawInput: z.unknown().optional(),
  })
  .passthrough();

export const cursorRequestPermissionParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    toolCall: permissionToolCallSchema,
    options: z.array(permissionOptionSchema).min(1),
  })
  .passthrough();

export function permissionKindForAcpKind(acpKind: string): PermissionKind {
  const row = CURSOR_ACP_KIND_APPROVAL_TABLE.find((entry) => entry.acpKind === acpKind);
  return row?.permissionKind ?? CURSOR_ACP_KIND_FALLBACK_PERMISSION_KIND;
}

export function approvalClassForAcpKind(
  acpKind: string,
): 'command' | 'file_read' | 'file_change' | 'dynamic_tool' {
  const row = CURSOR_ACP_KIND_APPROVAL_TABLE.find((entry) => entry.acpKind === acpKind);
  return row?.approvalClass ?? CURSOR_ACP_KIND_FALLBACK_APPROVAL_CLASS;
}

export function shouldAutoApproveAcpKind(autonomy: Autonomy, acpKind: string): boolean {
  const row = CURSOR_AUTONOMY_TABLE.find((entry) => entry.autonomy === autonomy);
  if (!row) {
    return false;
  }
  if (row.autoApproveAcpKinds === 'all') {
    return true;
  }
  return row.autoApproveAcpKinds.some((kind) => kind === acpKind);
}

export function normalizeAcpOptionKind(kind: string): string {
  return kind.trim().toLowerCase().replace(/-/g, '_');
}

export function selectAdvertisedAllowOptionId(
  options: readonly CursorAcpPermissionOption[],
): string | undefined {
  const allowAlways = options.find(
    (option) => normalizeAcpOptionKind(option.kind) === 'allow_always',
  );
  if (allowAlways) {
    return allowAlways.optionId;
  }
  const allowOnce = options.find((option) => normalizeAcpOptionKind(option.kind) === 'allow_once');
  return allowOnce?.optionId;
}

export function mapApprovalDecisionToAcpResult(
  decision: ProviderApprovalDecision,
  options: readonly CursorAcpPermissionOption[],
): { outcome: { outcome: 'cancelled' } } | { outcome: { outcome: 'selected'; optionId: string } } {
  if (decision.decision === 'cancel') {
    return CURSOR_PERMISSION_CANCELLED_RESULT;
  }
  const optionId =
    decision.decision === 'option'
      ? selectAdvertisedOptionId(options, decision.option)
      : selectAdvertisedOptionIdByKind(options, optionKindForDecision(decision.decision));
  if (optionId === undefined) {
    return CURSOR_PERMISSION_CANCELLED_RESULT;
  }
  return { outcome: { outcome: 'selected', optionId } };
}

export function parseCursorPermissionRequest(
  params: unknown,
): CursorParsedPermissionRequest | undefined {
  const parsed = cursorRequestPermissionParamsSchema.safeParse(params);
  if (!parsed.success) {
    return undefined;
  }
  const acpKind = parsed.data.toolCall.kind?.trim() || 'other';
  const title = parsed.data.toolCall.title?.trim() || defaultTitleForAcpKind(acpKind);
  const detail = permissionDetail(parsed.data.toolCall, title);
  const options = parsed.data.options.map((option) => ({
    optionId: option.optionId,
    kind: option.kind,
    ...(option.name?.trim() ? { name: option.name.trim() } : {}),
  }));
  return {
    toolCallId: parsed.data.toolCall.toolCallId,
    acpKind,
    title,
    detail,
    permissionKind: permissionKindForAcpKind(acpKind),
    approvalClass: approvalClassForAcpKind(acpKind),
    options,
  };
}

function optionKindForDecision(decision: 'allow_once' | 'allow_session' | 'deny'): string {
  const row = CURSOR_DECISION_TO_OPTION_KIND.find((entry) => entry.decision === decision);
  if (!row) {
    throw new Error('unmapped approval decision');
  }
  return row.optionKind;
}

function selectAdvertisedOptionId(
  options: readonly CursorAcpPermissionOption[],
  optionId: string,
): string | undefined {
  const match = options.find((option) => option.optionId === optionId);
  return match?.optionId;
}

function selectAdvertisedOptionIdByKind(
  options: readonly CursorAcpPermissionOption[],
  optionKind: string,
): string | undefined {
  const wanted = normalizeAcpOptionKind(optionKind);
  const match = options.find((option) => normalizeAcpOptionKind(option.kind) === wanted);
  return match?.optionId;
}

function defaultTitleForAcpKind(acpKind: string): string {
  switch (approvalClassForAcpKind(acpKind)) {
    case 'command':
      return 'Run command';
    case 'file_read':
      return 'Read file';
    case 'file_change':
      return 'Change file';
    default:
      return 'Tool call';
  }
}

function permissionDetail(toolCall: { title?: string; rawInput?: unknown }, title: string): string {
  if (!isPlainObject(toolCall.rawInput)) {
    return title;
  }
  const command = toolCall.rawInput.command;
  if (typeof command === 'string' && command.trim()) {
    return command.trim();
  }
  const path = toolCall.rawInput.path;
  if (typeof path === 'string' && path.trim()) {
    return path.trim();
  }
  return title;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
