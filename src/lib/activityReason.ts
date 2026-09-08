import type { PermissionRequest, SessionQuestion, SessionSummary } from '../types/bridge';
import type { GitDiffStat } from '../types/vcs';
import type { ActivityDigest } from './activityDigest';
import type { SessionActivityStatus } from './sidebarActivity';

export interface ActivityContext {
  session: SessionSummary;
  permission?: PermissionRequest;
  question?: SessionQuestion;
  digest?: ActivityDigest;
  diff?: GitDiffStat;
}

// One line under the title saying why a chat is where it is in the inbox:
// the command waiting for approval, the question the model asked, the file it
// is editing, or the changes sitting uncommitted.
export function activityReason(status: SessionActivityStatus, ctx: ActivityContext): string {
  switch (status) {
    case 'approval':
      return ctx.permission ? join('Approve', ctx.permission.detail || ctx.permission.title) : '';
    case 'input':
      return ctx.question?.questions[0]?.question ?? '';
    case 'plan':
      return ctx.session.phase === 'awaiting_plan_approval'
        ? 'Plan is ready for your approval'
        : 'Ready to start';
    case 'failed':
      return join('Failed', ctx.session.interruptReason ?? ctx.digest?.snippet);
    case 'interrupted':
      return ctx.session.interruptReason ?? 'Turn was interrupted';
    case 'working':
      return ctx.digest?.activity ?? 'Thinking…';
    case 'ship':
      return ctx.diff ? diffSummary(ctx.diff) : '';
    case 'reply':
    case 'review':
    case 'ready':
      return ctx.digest?.snippet ?? '';
    default:
      return '';
  }
}

function join(head: string, tail?: string): string {
  const rest = tail?.replace(/\s+/g, ' ').trim();
  return rest ? `${head} · ${rest}` : head;
}

function diffSummary(diff: GitDiffStat): string {
  const files = `${String(diff.files)} file${diff.files === 1 ? '' : 's'} uncommitted`;
  return `${files} · +${String(diff.additions)} −${String(diff.deletions)}`;
}
