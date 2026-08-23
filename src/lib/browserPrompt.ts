export type BrowserPermissionPromptKind = 'question' | 'warning' | 'permission' | 'credential';

export interface BrowserPermissionPrompt {
  requestId: string;
  kind: BrowserPermissionPromptKind;
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  cancelId: number;
}

function requireBrowserPromptApi() {
  const api = typeof window !== 'undefined' ? window.droidControl : undefined;
  if (!api) throw new Error('Browser permission prompts require the desktop app.');
  return api;
}

export function onBrowserPermissionPrompt(
  handler: (prompt: BrowserPermissionPrompt) => void,
): () => void {
  return requireBrowserPromptApi().onBrowserPermissionPrompt(handler);
}

export function onBrowserPermissionPromptDismiss(handler: (requestId: string) => void): () => void {
  return requireBrowserPromptApi().onBrowserPermissionPromptDismiss(handler);
}

export function resolveBrowserPermissionPrompt(
  requestId: string,
  response: number,
): Promise<boolean> {
  return requireBrowserPromptApi().browserPermissionPromptResolve(requestId, response);
}
