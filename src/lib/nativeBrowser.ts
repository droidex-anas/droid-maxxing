import { isDesktop } from './desktop';
import type {
  BrowserNativeRequest,
  BrowserNativeResult,
  BrowserNativeSnapshot,
  DesignAnchor,
  DesignAnchorDetail,
  DesignSelectionScreenshot,
  DesignStrokePoint,
} from '../types/bridge';

export interface NativeBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeBrowserSelection {
  browserSessionId?: string;
  anchor: DesignAnchor;
  detail?: DesignAnchorDetail;
  url: string;
  title?: string;
  scroll?: { x: number; y: number };
  screenshot?: DesignSelectionScreenshot;
  strokes?: DesignStrokePoint[][];
}

export interface NativeBrowserLoaded {
  browserSessionId?: string;
  url: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface NativeBrowserLoadFailed {
  browserSessionId?: string;
  url: string;
  error?: string;
}

export interface NativeBrowserDesignPrompt {
  selection: NativeBrowserSelection;
  instruction: string;
}

export type NativeBrowserAgentAction = BrowserNativeRequest;
export type NativeBrowserAgentResult = BrowserNativeResult;

const NATIVE_BROWSER_TRANSPORT_TIMEOUT_MS = 10_000;
const NATIVE_BROWSER_INTERACTIVE_TIMEOUT_MS = 180_000;
const INTERACTIVE_BROWSER_ACTIONS = new Set<NativeBrowserAgentAction['action']>([
  'open',
  'goBack',
  'goForward',
  'click',
  'fillCredentials',
]);

export async function attachNativeBrowser(
  browserSessionId: string,
  bounds: NativeBrowserBounds,
  url?: string,
): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserAttach(browserSessionId, normalizeBounds(bounds), url);
}

export async function detachNativeBrowser(browserSessionId?: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserDetach(browserSessionId);
}

export async function setNativeBrowserBounds(
  browserSessionId: string,
  bounds: NativeBrowserBounds,
): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserSetBounds(browserSessionId, normalizeBounds(bounds));
}

export async function setNativeBrowserVisible(
  browserSessionId: string,
  visible: boolean,
): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserSetVisible(browserSessionId, visible);
}

export async function goBackNativeBrowser(browserSessionId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return window.droidControl!.nativeBrowserGoBack(browserSessionId);
}

export async function goForwardNativeBrowser(browserSessionId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return window.droidControl!.nativeBrowserGoForward(browserSessionId);
}

export async function runNativeBrowserAgentAction(
  request: NativeBrowserAgentAction,
  timeoutMs = nativeBrowserAgentActionTimeoutMs(request),
  bounds?: NativeBrowserBounds,
): Promise<NativeBrowserAgentResult> {
  if (!isDesktop()) throw new Error('DROIDEX Browser is only available in the desktop app.');
  let timeout: number | undefined;
  try {
    const result = await Promise.race([
      window.droidControl!.nativeBrowserAgentAction(request, bounds),
      new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error(`DROIDEX Browser action ${request.action} timed out.`)),
          timeoutMs,
        );
      }),
    ]);
    if (!result || result.requestId !== request.requestId) {
      throw new Error('Native browser returned a mismatched agent result.');
    }
    return result;
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

function nativeBrowserAgentActionTimeoutMs(request: NativeBrowserAgentAction): number {
  const canPromptForAuthentication = request.action === 'keypress' && request.key === 'Enter';
  return INTERACTIVE_BROWSER_ACTIONS.has(request.action) || canPromptForAuthentication
    ? NATIVE_BROWSER_INTERACTIVE_TIMEOUT_MS
    : NATIVE_BROWSER_TRANSPORT_TIMEOUT_MS;
}

export async function performDesktopNativeBrowserRequest(
  request: BrowserNativeRequest,
): Promise<BrowserNativeResult> {
  try {
    if (!isDesktop()) throw new Error('The native browser is only available in the desktop app.');
    return await runNativeBrowserAgentAction(request);
  } catch (error) {
    return nativeResult(
      request,
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function nativeResult(
  request: BrowserNativeRequest,
  ok: boolean,
  snapshot?: BrowserNativeSnapshot,
  error?: string,
): BrowserNativeResult {
  return {
    requestId: request.requestId,
    appSessionId: request.appSessionId,
    browserSessionId: request.browserSessionId,
    ok,
    snapshot,
    error,
  };
}

export async function setNativeBrowserDesignMode(
  browserSessionId: string,
  active: boolean,
): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserSetDesignMode(browserSessionId, active);
}

export async function setNativeBrowserPencilMode(
  browserSessionId: string,
  active: boolean,
): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserSetPencilMode(browserSessionId, active);
}

export async function onNativeBrowserSelection(
  handler: (selection: NativeBrowserSelection) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return window.droidControl!.onNativeBrowserSelection(handler);
}

export async function onNativeBrowserDesignPrompt(
  handler: (prompt: NativeBrowserDesignPrompt) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return window.droidControl!.onNativeBrowserDesignPrompt(handler);
}

export async function onNativeBrowserLoaded(
  handler: (event: NativeBrowserLoaded) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return window.droidControl!.onNativeBrowserLoaded(handler);
}

export async function onNativeBrowserLoadFailed(
  handler: (event: NativeBrowserLoadFailed) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return window.droidControl!.onNativeBrowserLoadFailed(handler);
}

function normalizeBounds(bounds: NativeBrowserBounds): NativeBrowserBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}
