import type { PermissionOutcome } from './protocol.js';

const PERMISSION_OUTCOMES: Record<PermissionOutcome, true> = {
  proceed_once: true,
  proceed_always: true,
  proceed_auto_run: true,
  proceed_auto_run_low: true,
  proceed_auto_run_medium: true,
  proceed_auto_run_high: true,
  proceed_new_session: true,
  proceed_new_session_low: true,
  proceed_new_session_medium: true,
  proceed_new_session_high: true,
  proceed_edit: true,
  cancel: true,
};

// An MCP always-allow the renderer may still send; DROIDEX records it as a plain
// always-allow grant.
const OUTCOME_ALIASES = new Map<string, PermissionOutcome>([
  ['proceed_always_tools', 'proceed_always'],
]);

export function normalizePermissionOutcome(outcome: string): PermissionOutcome {
  const alias = OUTCOME_ALIASES.get(outcome);
  if (alias) return alias;
  if (Object.hasOwn(PERMISSION_OUTCOMES, outcome)) return outcome as PermissionOutcome;
  throw new Error(`Unsupported permission outcome: ${outcome}`);
}

export function isApprovalOutcome(outcome: string): boolean {
  return normalizePermissionOutcome(outcome) !== 'cancel';
}

// True only for a valid "always allow" outcome. Invalid/unknown outcomes return
// false so they can never persist an always-allow grant.
export function isAlwaysOutcome(outcome: string): boolean {
  try {
    return normalizePermissionOutcome(outcome) === 'proceed_always';
  } catch {
    return false;
  }
}
