import type { FileChange } from './diff';
import type { DiffScope } from '../types/vcs';
import { matchReviewFocusPath, nextReviewFocusScope } from './reviewScopes';

export interface OpenReviewAtAction {
  type: 'OPEN_REVIEW_AT';
  scope: DiffScope;
  path?: string | null;
  change?: FileChange;
}

export function openReviewAt(
  path: string,
  change?: FileChange,
  scope: DiffScope = 'last_turn',
): OpenReviewAtAction {
  return { type: 'OPEN_REVIEW_AT', scope, path, change };
}

export type OpenReviewFileHandler = (path: string, change?: FileChange) => void;

export interface ReviewFocusFields {
  reviewFocusPath: string | null;
  reviewFocusChange: FileChange | null;
  reviewFocusRequestId: number;
}

// Store the clicked path and any captured transcript change so Review can
// render that exact edit independently of the current Git diff.
export function applyOpenReviewAt<T extends ReviewFocusFields>(
  state: T,
  action: OpenReviewAtAction,
): T {
  return {
    ...state,
    reviewFocusPath: action.path ?? null,
    reviewFocusChange: action.change ?? null,
    reviewFocusRequestId: state.reviewFocusRequestId + 1,
  };
}

export function clearReviewFocus<T extends ReviewFocusFields>(state: T): T {
  if (state.reviewFocusPath === null && state.reviewFocusChange === null) return state;
  return { ...state, reviewFocusPath: null, reviewFocusChange: null };
}

// After every git scope has been tried, Review still has something to show:
// the change captured from the transcript, or a path-only on-disk preview.
export type ExhaustedReviewFocus =
  | { kind: 'change'; change: FileChange }
  | { kind: 'preview'; path: string; content: null };

export function exhaustedReviewFocus(
  change: FileChange | null | undefined,
  path: string,
): ExhaustedReviewFocus {
  return change ? { kind: 'change', change } : { kind: 'preview', path, content: null };
}

export type ReviewFocusPlan =
  | { kind: 'idle' }
  | { kind: 'wait' }
  | { kind: 'jump'; path: string }
  | {
      kind: 'advance';
      path: string;
      scope: DiffScope;
      attemptKey: string;
    }
  | { kind: 'detached'; focus: ExhaustedReviewFocus };

// Decide what Review should do with a focus request. A captured transcript
// change is shown immediately regardless of the current Git list, so a
// folderless session never falls through to the "No current diff" toast.
export function planReviewFocus(args: {
  focusPath: string | null;
  focusChange: FileChange | null | undefined;
  files: readonly { path: string }[];
  loadingList: boolean;
  cwd?: string;
  currentScope: DiffScope;
  requestId: number;
  alreadyTriedKey: string | null;
}): ReviewFocusPlan {
  const {
    focusPath,
    focusChange,
    files,
    loadingList,
    cwd,
    currentScope,
    requestId,
    alreadyTriedKey,
  } = args;
  if (!focusPath) return { kind: 'idle' };
  if (focusChange) {
    return { kind: 'detached', focus: exhaustedReviewFocus(focusChange, focusPath) };
  }
  if (loadingList) return { kind: 'wait' };
  const targetPath = matchReviewFocusPath(files, focusPath, cwd);
  if (targetPath) return { kind: 'jump', path: targetPath };
  const nextScope = nextReviewFocusScope(currentScope);
  const attemptKey = `${String(requestId)}:${currentScope}→${focusPath}`;
  if (nextScope && alreadyTriedKey !== attemptKey) {
    return {
      kind: 'advance',
      path: focusPath,
      scope: nextScope,
      attemptKey,
    };
  }
  return { kind: 'detached', focus: exhaustedReviewFocus(focusChange, focusPath) };
}
