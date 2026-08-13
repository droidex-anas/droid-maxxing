import type { PermissionKind, TranscriptEvent } from '../types/bridge';

const FALLBACK_PURPOSE: Record<PermissionKind, string> = {
  exec: 'This command needs your approval before it can run.',
  edit: 'This file change needs your approval before it can be applied.',
  create: 'Creating this file needs your approval.',
  apply_patch: 'Applying this code change needs your approval.',
  mcp: 'Using this external tool needs your approval.',
  spec: 'Moving from planning to implementation needs your approval.',
  mission_plan: 'Starting this mission plan needs your approval.',
  other: 'Droid needs your approval before it can continue.',
};

function normalizePurpose(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function summarizeUserRequest(text: string): string {
  const normalized = normalizePurpose(text);
  const summary = normalized.length > 180 ? `${normalized.slice(0, 179).trimEnd()}…` : normalized;
  return `To complete your request: “${summary}”`;
}

export function permissionPurpose(
  kind: PermissionKind,
  transcript: TranscriptEvent[] | undefined,
): string {
  if (transcript) {
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const event = transcript[index];
      if (event.kind === 'text' && event.author === 'user' && event.text) {
        return summarizeUserRequest(event.text);
      }
      if (event.kind !== 'text' || !event.text) continue;
      const purpose = normalizePurpose(event.text);
      if (purpose) return purpose;
    }
  }
  return FALLBACK_PURPOSE[kind];
}
