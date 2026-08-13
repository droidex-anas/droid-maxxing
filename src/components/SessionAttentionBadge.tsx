import type { SessionAttentionKind } from '../lib/sessionAttention';

const KIND_LABEL: Record<SessionAttentionKind, string> = {
  approval: 'Awaiting approval',
  question: 'Awaiting answer',
};

const KIND_DESCRIPTION: Record<SessionAttentionKind, string> = {
  approval: 'Waiting for your approval',
  question: 'Waiting for your answer',
};

// Compact status on the right of a sidebar row, replacing the timestamp while
// the session is blocked on the user.
export function SessionAttentionBadge({ kind }: { kind: SessionAttentionKind }) {
  return (
    <span
      title={KIND_DESCRIPTION[kind]}
      className="max-w-[112px] shrink-0 truncate rounded-full bg-droid-green/15 px-2.5 py-1 text-[11px] font-medium leading-none text-droid-green"
    >
      {KIND_LABEL[kind]}
    </span>
  );
}
