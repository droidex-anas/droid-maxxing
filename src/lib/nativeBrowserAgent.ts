import type { BrowserNativeRequest, BrowserNativeResult } from '../types/bridge';
import { isDesktop } from './desktop';
import { performDesktopNativeBrowserRequest } from './nativeBrowser';
import { BrowserSemanticStateTracker } from './nativeBrowserSemanticTracker';
import type {
  BrowserSemanticObservation,
  BrowserSemanticState,
} from './nativeBrowserSemanticTypes';

export interface NativeBrowserController {
  perform(request: BrowserNativeRequest): Promise<BrowserNativeResult>;
}

export interface NativeBrowserSemanticRequestOptions {
  timeoutMs?: number;
  sinceRevision?: number;
}

export interface NativeBrowserSemanticRequestResult {
  result: BrowserNativeResult;
  observation?: BrowserSemanticObservation;
}

let controller: NativeBrowserController | null = null;
const waiters = new Set<() => void>();
const semanticTrackers = new Map<string, BrowserSemanticStateTracker>();
const OPEN_CONTROLLER_GRACE_MS = 250;

export function registerNativeBrowserController(next: NativeBrowserController): () => void {
  controller = next;
  for (const notify of waiters) notify();
  waiters.clear();
  return () => {
    if (controller === next) controller = null;
  };
}

function semanticTracker(browserSessionId: string): BrowserSemanticStateTracker {
  let tracker = semanticTrackers.get(browserSessionId);
  if (!tracker) {
    tracker = new BrowserSemanticStateTracker();
    semanticTrackers.set(browserSessionId, tracker);
  }
  return tracker;
}

function observeNativeBrowserResult(
  request: BrowserNativeRequest,
  result: BrowserNativeResult,
  sinceRevision?: number,
): BrowserSemanticObservation | undefined {
  if (request.action === 'close' && result.ok) {
    semanticTrackers.delete(request.browserSessionId);
    return undefined;
  }
  if (!result.snapshot) return undefined;

  return semanticTracker(request.browserSessionId).observe(
    result.snapshot,
    sinceRevision === undefined ? {} : { sinceRevision },
  );
}

async function executeNativeBrowserRequest(
  request: BrowserNativeRequest,
  timeoutMs: number,
): Promise<BrowserNativeResult> {
  if (!controller && isDesktop()) {
    if (request.action === 'open') {
      const mounted = await waitForController(Math.min(timeoutMs, OPEN_CONTROLLER_GRACE_MS)).catch(
        () => null,
      );
      if (mounted) return mounted.perform(request);
    }
    return performDesktopNativeBrowserRequest(request);
  }
  const active = controller ?? (await waitForController(timeoutMs));
  return active.perform(request);
}

export async function performNativeBrowserRequest(
  request: BrowserNativeRequest,
  timeoutMs = 8_000,
): Promise<BrowserNativeResult> {
  const result = await executeNativeBrowserRequest(request, timeoutMs);
  observeNativeBrowserResult(request, result);
  return result;
}

export async function performNativeBrowserRequestWithSemanticState(
  request: BrowserNativeRequest,
  options: NativeBrowserSemanticRequestOptions = {},
): Promise<NativeBrowserSemanticRequestResult> {
  const result = await executeNativeBrowserRequest(request, options.timeoutMs ?? 8_000);
  const observation = observeNativeBrowserResult(request, result, options.sinceRevision);
  return observation ? { result, observation } : { result };
}

export function getNativeBrowserSemanticState(
  browserSessionId: string,
): BrowserSemanticState | undefined {
  return semanticTrackers.get(browserSessionId)?.current;
}

export function getNativeBrowserSemanticObservation(
  browserSessionId: string,
  sinceRevision?: number,
): BrowserSemanticObservation | undefined {
  return semanticTrackers.get(browserSessionId)?.read(sinceRevision);
}

export function resetNativeBrowserSemanticState(browserSessionId?: string): void {
  if (browserSessionId !== undefined) {
    semanticTrackers.delete(browserSessionId);
    return;
  }
  semanticTrackers.clear();
}

function waitForController(timeoutMs: number): Promise<NativeBrowserController> {
  if (controller) return Promise.resolve(controller);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      waiters.delete(notify);
      reject(new Error('Droid Control browser pane is not ready.'));
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
