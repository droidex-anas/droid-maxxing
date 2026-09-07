import type { BrowserNativeRequest, BrowserNativeResult } from '../types/bridge';
import { isDesktop } from './desktop';
import { performDesktopNativeBrowserRequest } from './nativeBrowser';

export interface NativeBrowserController {
  appSessionId: string;
  browserSessionId?: string;
  perform(request: BrowserNativeRequest): Promise<BrowserNativeResult>;
}

let controller: NativeBrowserController | null = null;
const waiters = new Set<() => void>();

export interface NativeBrowserRequestOptions {
  surface?: 'visible' | 'background';
  timeoutMs?: number;
}

export function registerNativeBrowserController(next: NativeBrowserController): () => void {
  controller = next;
  for (const notify of waiters) notify();
  waiters.clear();
  return () => {
    if (controller === next) controller = null;
  };
}

export async function performNativeBrowserRequest(
  request: BrowserNativeRequest,
  options: NativeBrowserRequestOptions = {},
): Promise<BrowserNativeResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (isDesktop() || options.surface === 'background') {
    return performDesktopNativeBrowserRequest(request);
  }
  const active = controller ?? (await waitForController(timeoutMs));
  const matchesBrowser = active.browserSessionId
    ? active.browserSessionId === request.browserSessionId
    : request.action === 'open';
  if (controller !== active || active.appSessionId !== request.appSessionId || !matchesBrowser) {
    throw new Error('The requested DROIDEX Browser pane is no longer active.');
  }
  return active.perform(request);
}

function waitForController(timeoutMs: number): Promise<NativeBrowserController> {
  if (controller) return Promise.resolve(controller);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      waiters.delete(notify);
      reject(new Error('DROIDEX Browser pane is not ready.'));
    }, timeoutMs);
    const notify = () => {
      if (!controller) return;
      window.clearTimeout(timeout);
      waiters.delete(notify);
      resolve(controller);
    };
    waiters.add(notify);
  });
}
