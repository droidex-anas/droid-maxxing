import type { AutomationDraft } from './types';

export interface AutomationSuggestion {
  title: string;
  detail: string;
  draft: Pick<AutomationDraft, 'title' | 'prompt' | 'enabled' | 'schedule'>;
}

/** Starting points while a user has no automations yet. */
export const AUTOMATION_SUGGESTIONS: readonly AutomationSuggestion[] = [
  {
    title: 'Daily repository brief',
    detail:
      'Review recent changes, pull requests, failing tests, and the most important next actions.',
    draft: {
      title: 'Daily repository brief',
      prompt:
        'Review recent repository changes, open pull requests, failing tests, and unfinished work. Give me a concise brief with the most important next actions.',
      enabled: true,
      schedule: { kind: 'weekdays', time: '09:00' },
    },
  },
  {
    title: 'Weekly progress review',
    detail: 'Turn the week’s work into a clear progress and priorities summary every Friday.',
    draft: {
      title: 'Weekly progress review',
      prompt:
        'Review this week’s repository activity and chats. Summarize what shipped, what is blocked, and what should be prioritized next week.',
      enabled: true,
      schedule: { kind: 'weekly', weekday: 5, time: '16:00' },
    },
  },
  {
    title: 'Follow-up monitor',
    detail: 'Find unresolved TODOs, failing checks, and review comments that still need attention.',
    draft: {
      title: 'Follow-up monitor',
      prompt:
        'Review recent work for unresolved TODOs, failing checks, unanswered review comments, and other follow-ups. Only report items that need attention.',
      enabled: true,
      schedule: { kind: 'daily', time: '10:00' },
    },
  },
];
