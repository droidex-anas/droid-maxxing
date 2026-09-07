import type { BrowserPermissionPrompt } from '../lib/browserPrompt';

interface BrowserPromptState {
  prompt: BrowserPermissionPrompt | null;
  pending: BrowserPermissionPrompt | null;
  error: string | null;
}

type BrowserPromptAction =
  | { type: 'show'; prompt: BrowserPermissionPrompt }
  | { type: 'dismiss'; requestId: string }
  | { type: 'choose'; requestId: string }
  | { type: 'settled'; requestId: string; error: string | null };

export const emptyBrowserPromptState: BrowserPromptState = {
  prompt: null,
  pending: null,
  error: null,
};

export function browserPromptReducer(
  state: BrowserPromptState,
  action: BrowserPromptAction,
): BrowserPromptState {
  switch (action.type) {
    case 'show':
      return { prompt: action.prompt, pending: null, error: null };
    case 'dismiss':
      return state.prompt?.requestId === action.requestId ||
        state.pending?.requestId === action.requestId
        ? emptyBrowserPromptState
        : state;
    case 'choose':
      return state.prompt?.requestId === action.requestId && !state.pending
        ? { prompt: null, pending: state.prompt, error: null }
        : state;
    case 'settled':
      if (state.pending?.requestId !== action.requestId) return state;
      return { prompt: action.error ? state.pending : null, pending: null, error: action.error };
  }
}
