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
type DesktopApi = NonNullable<Window['droidControl']>;
const INTERACTIVE_BROWSER_ACTIONS = new Set<NativeBrowserAgentAction['action']>([
  'open',
  'reload',
  'goBack',
  'goForward',
  'click',
  'fillCredentials',
]);

function requireDesktopApi(): DesktopApi {
  const api = typeof window === 'undefined' ? undefined : window.droidControl;
  if (!api) throw new Error('DROIDEX desktop bridge is unavailable.');
  return api;
}

function noop(): void {
  return undefined;
}

export async function attachNativeBrowser(
  browserSessionId: string,
  bounds: NativeBrowserBounds,
  url?: string,
): Promise<void> {
  if (!isDesktop()) return;
  await requireDesktopApi().nativeBrowserAttach(browserSessionId, normalizeBounds(bounds), url);
}

export async function detachNativeBrowser(browserSessionId?: string): Promise<void> {
  if (!isDesktop()) return;
  await requireDesktopApi().nativeBrowserDetach(browserSessionId);
}

export async function setNativeBrowserBounds(
  browserSessionId: string,
  bounds: NativeBrowserBounds,
): Promise<void> {
  if (!isDesktop()) return;
  await requireDesktopApi().nativeBrowserSetBounds(browserSessionId, normalizeBounds(bounds));
}

export async function setNativeBrowserVisible(
  browserSessionId: string,
  visible: boolean,
  agentCursorActive: boolean,
): Promise<void> {
  if (!isDesktop()) return;
  await requireDesktopApi().nativeBrowserSetVisible(browserSessionId, visible, agentCursorActive);
}

export async function goBackNativeBrowser(browserSessionId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return requireDesktopApi().nativeBrowserGoBack(browserSessionId);
}

export async function goForwardNativeBrowser(browserSessionId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return requireDesktopApi().nativeBrowserGoForward(browserSessionId);
}

export async function runNativeBrowserAgentAction(
  request: NativeBrowserAgentAction,
  timeoutMs = nativeBrowserAgentActionTimeoutMs(request),
): Promise<NativeBrowserAgentResult> {
  if (!isDesktop()) throw new Error('DROIDEX Browser is only available in the desktop app.');
  const api = requireDesktopApi();
  let timeout: number | undefined;
  try {
    const result = await Promise.race([
      api.nativeBrowserAgentAction(request),
      new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(() => {
          void api
            .nativeBrowserAgentActionCancel(request.browserSessionId, request.requestId)
            .catch(() => undefined);
          reject(new Error(`DROIDEX Browser action ${request.action} timed out.`));
        }, timeoutMs);
      }),
    ]);
    if (result?.requestId !== request.requestId) {
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
  await requireDesktopApi().nativeBrowserSetDesignMode(browserSessionId, active);
}

export async function setNativeBrowserPencilMode(
  browserSessionId: string,
  active: boolean,
): Promise<void> {
  if (!isDesktop()) return;
  await requireDesktopApi().nativeBrowserSetPencilMode(browserSessionId, active);
}

export function onNativeBrowserSelection(
  handler: (selection: NativeBrowserSelection) => void,
): Promise<() => void> {
  if (!isDesktop()) return Promise.resolve(noop);
  return Promise.resolve(requireDesktopApi().onNativeBrowserSelection(handler));
}

export function onNativeBrowserDesignPrompt(
  handler: (prompt: NativeBrowserDesignPrompt) => void,
): Promise<() => void> {
  if (!isDesktop()) return Promise.resolve(noop);
  return Promise.resolve(requireDesktopApi().onNativeBrowserDesignPrompt(handler));
}

export function onNativeBrowserLoaded(
  handler: (event: NativeBrowserLoaded) => void,
): Promise<() => void> {
  if (!isDesktop()) return Promise.resolve(noop);
  return Promise.resolve(requireDesktopApi().onNativeBrowserLoaded(handler));
}

export function onNativeBrowserLoadFailed(
  handler: (event: NativeBrowserLoadFailed) => void,
): Promise<() => void> {
  if (!isDesktop()) return Promise.resolve(noop);
  return Promise.resolve(requireDesktopApi().onNativeBrowserLoadFailed(handler));
}

function normalizeBounds(bounds: NativeBrowserBounds): NativeBrowserBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}
