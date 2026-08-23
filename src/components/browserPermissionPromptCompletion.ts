import { resolveBrowserPermissionPrompt } from '../lib/browserPrompt';

interface BrowserPermissionPromptCompletionOptions {
  close: () => void;
  waitForClosePaint?: () => Promise<void>;
  resolve?: (requestId: string, response: number) => Promise<boolean>;
}

export async function completeBrowserPermissionPrompt(
  requestId: string,
  response: number,
  options: BrowserPermissionPromptCompletionOptions,
): Promise<boolean> {
  options.close();
  await (options.waitForClosePaint ?? waitForBrowserPromptClosePaint)();
  return (options.resolve ?? resolveBrowserPermissionPrompt)(requestId, response);
}

export async function settleBrowserPermissionPrompt(
  requestId: string,
  response: number,
  options: BrowserPermissionPromptCompletionOptions,
): Promise<string | null> {
  try {
    await completeBrowserPermissionPrompt(requestId, response, options);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'DROIDEX could not apply that choice.';
  }
}

function waitForBrowserPromptClosePaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}
