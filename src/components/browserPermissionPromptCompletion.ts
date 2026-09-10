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
  const accepted = await (options.resolve ?? resolveBrowserPermissionPrompt)(requestId, response);
  if (!accepted) throw new Error('DROIDEX could not apply that choice.');
  return true;
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

// Resolve once the closing sheet has painted, but never wait on frames alone:
// a minimized or occluded window throttles requestAnimationFrame, and the
// permission request stays unanswered until it is shown again.
function waitForBrowserPromptClosePaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    setTimeout(finish, 120);
    requestAnimationFrame(() => {
      requestAnimationFrame(finish);
    });
  });
}
