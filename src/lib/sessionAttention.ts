import type { PermissionRequest, SessionQuestion } from '../types/bridge';

// A session "needs attention" when it is blocked on the user rather than the
// model: a pending permission approval or a pending AskUser question. Pending
// requests are keyed by session, so this selector answers it per chat and the
// sidebar can signal work waiting in a background session.
export type SessionAttentionKind = 'approval' | 'question';

export function sessionAttention(
  appSessionId: string,
  pendingPermissions: Record<string, PermissionRequest | undefined>,
  pendingQuestions: Record<string, SessionQuestion | undefined>,
): SessionAttentionKind | null {
  if (pendingPermissions[appSessionId]) return 'approval';
  if (pendingQuestions[appSessionId]) return 'question';
  return null;
}
