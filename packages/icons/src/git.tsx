import { createIcon } from './Icon.js';

// Stroked node circles joined by rails with one soft elbow, Codex style.
export const GitBranch = createIcon(
  'git-branch',
  <>
    <circle cx="6.5" cy="5.5" r="2.5" />
    <circle cx="6.5" cy="17" r="2.5" />
    <circle cx="17.5" cy="6.5" r="2.5" />
    <path d="M6.5 8v6.5" />
    <path d="M17.5 9v3a5 5 0 0 1-5 5H9" />
  </>,
);

export const GitCommit = createIcon(
  'git-commit',
  <>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M3.5 12h5.3" />
    <path d="M15.2 12h5.3" />
  </>,
);

export const GitPullRequest = createIcon(
  'git-pull-request',
  <>
    <circle cx="6.5" cy="5.5" r="2.5" />
    <circle cx="6.5" cy="18.5" r="2.5" />
    <circle cx="17.5" cy="18.5" r="2.5" />
    <path d="M6.5 8v8" />
    <path d="M17.5 16V9.5a4 4 0 0 0-4-4h-2.3" />
    <path d="m13.7 3-2.5 2.5 2.5 2.5" />
  </>,
);

export const GitCompareArrows = createIcon(
  'git-compare-arrows',
  <>
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="6" r="2.4" />
    <path d="M6 15.6V9a3.5 3.5 0 0 1 3.5-3.5H14" />
    <path d="m11.5 3 2.5 2.5-2.5 2.5" />
    <path d="M18 8.4V15a3.5 3.5 0 0 1-3.5 3.5H10" />
    <path d="m12.5 21-2.5-2.5 2.5-2.5" />
  </>,
);
