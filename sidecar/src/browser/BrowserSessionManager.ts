import { randomUUID } from 'node:crypto';
import type { BrowserRestoreState } from '../protocol.js';
import { BrowserDesignReferences } from './BrowserDesignReferences.js';
import { normalizeBrowserUrl } from './browserUrl.js';
import type { writeDesignPromptPack } from './designPromptPacks.js';
import { waitForBrowserCondition } from './browserWait.js';
import { SerializedBrowserRuntime } from './SerializedBrowserRuntime.js';
import type {
  BrowserBox,
  BrowserConsoleEvent,
  BrowserElementInspection,
  BrowserElementRef,
  BrowserNetworkEvent,
  BrowserScreenshotOptions,
  BrowserSnapshot,
  BrowserState,
  BrowserViewport,
  BrowserViewportMode,
  DesignAnchor,
  DesignAnchorDetail,
  DesignReference,
  DesignSelectionScreenshot,
  ScrollDirection,
} from './types.js';

export interface BrowserSessionManagerOptions {
  emit?: (
    event:
      | { type: 'browser.updated'; state: BrowserState }
      | { type: 'browser.error'; appSessionId?: string; message: string },
  ) => void;
  runtimeFactory?: (
    browserSessionId: string,
    viewport: BrowserViewport,
    appSessionId: string,
  ) => BrowserRuntime;
  assetUrlFor?: (path: string) => string;
  writePack?: typeof writeDesignPromptPack;
  browserDataDir?: string;
  waitNow?: () => number;
  waitDelay?: (milliseconds: number) => Promise<void>;
}

export interface BrowserRuntime {
  open(url: string, source?: BrowserInputSource): Promise<BrowserSnapshot>;
  reload(source?: BrowserInputSource): Promise<BrowserSnapshot>;
  goBack(): Promise<BrowserSnapshot>;
  goForward(): Promise<BrowserSnapshot>;
  setViewport(viewport: BrowserViewport, source?: BrowserInputSource): Promise<void>;
  screenshot(options?: BrowserScreenshotOptions): Promise<string>;
  capture(box?: BrowserBox, options?: BrowserScreenshotOptions): Promise<string>;
  snapshot(): Promise<BrowserSnapshot>;
  click(x: number, y: number, selector?: string, ref?: string): Promise<BrowserSnapshot>;
  hover(x: number, y: number, selector?: string, ref?: string): Promise<BrowserSnapshot>;
  selectOption(selector: string, value: string, ref?: string): Promise<BrowserSnapshot>;
  type(text: string): Promise<BrowserSnapshot>;
  keypress(key: string): Promise<BrowserSnapshot>;
  scroll(input: BrowserScrollAction): Promise<BrowserSnapshot>;
  inspect(selector: string, ref?: string): Promise<BrowserElementInspection>;
  network(clear?: boolean): Promise<BrowserNetworkEvent[]>;
  console(clear?: boolean): Promise<BrowserConsoleEvent[]>;
  fillCredentials?(): Promise<BrowserSnapshot>;
  close(): Promise<void>;
}

export interface BrowserScrollAction {
  direction: ScrollDirection;
  pixels?: number;
  x?: number;
  y?: number;
  selector?: string;
  ref?: string;
}

interface ManagedBrowserSession {
  id: string;
  appSessionId: string;
  runtime: BrowserRuntime;
  state: BrowserState;
  designReferences: BrowserDesignReferences;
}

export type BrowserInputSource = 'agent' | 'user';

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = {
  width: 1200,
  height: 800,
  deviceScaleFactor: 2,
};

// The wire contract owns the restore payload. restore() below rebuilds a
// BrowserState from it, so the compiler catches any drift between the two.
export type { BrowserRestoreState };

export class BrowserSessionManager {
  private readonly sessions = new Map<string, ManagedBrowserSession>();

  constructor(private readonly options: BrowserSessionManagerOptions = {}) {}

  async open(input: {
    appSessionId: string;
    url: string;
    source?: BrowserInputSource;
    viewport?: BrowserViewport;
    viewportMode?: BrowserViewportMode;
  }): Promise<BrowserState> {
    const session = this.sessionFor(input.appSessionId, input.viewport, input.viewportMode);
    const url = normalizeBrowserUrl(input.url);
    const previousViewport = session.state.viewport;
    const nextViewport = input.viewport ?? previousViewport;
    if (input.viewport) await session.runtime.setViewport(input.viewport, input.source);
    let snapshot: BrowserSnapshot;
    try {
      snapshot = await session.runtime.open(url, input.source);
    } catch (error) {
      if (input.viewport) {
        await session.runtime.setViewport(previousViewport, input.source).catch(() => undefined);
      }
      throw error;
    }
    const openSnapshot = { canGoBack: false, canGoForward: false, ...snapshot };
    const nextViewportMode = input.viewportMode ?? session.state.viewportMode;
    return this.updateFromSnapshot(session, openSnapshot, nextViewport, nextViewportMode);
  }

  restore(input: BrowserRestoreState): BrowserState {
    const existing = this.sessions.get(input.appSessionId);
    if (existing) {
      this.emitUpdated(existing.state);
      return existing.state;
    }
    for (const session of this.sessions.values()) {
      if (session.id === input.browserSessionId) {
        throw new Error(
          `Browser session ${input.browserSessionId} already belongs to another Droid chat.`,
        );
      }
    }
    const state: BrowserState = {
      ...input,
      url: normalizeBrowserUrl(input.url),
      viewport: { ...input.viewport },
      scroll: { ...input.scroll },
      refs: [],
    };
    const session = this.createSession(
      input.appSessionId,
      input.browserSessionId,
      input.viewport,
      state,
    );
    this.emitUpdated(session.state);
    return session.state;
  }

  async reload(appSessionId: string, source?: BrowserInputSource): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    return this.updateFromSnapshot(session, await session.runtime.reload(source));
  }

  async goBack(appSessionId: string): Promise<BrowserState> {
    return this.navigateHistory(appSessionId, 'back');
  }

  async goForward(appSessionId: string): Promise<BrowserState> {
    return this.navigateHistory(appSessionId, 'forward');
  }

  async refresh(appSessionId: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    return this.updateFromSnapshot(session, await session.runtime.snapshot());
  }

  private async navigateHistory(
    appSessionId: string,
    direction: 'back' | 'forward',
  ): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const snapshot =
      direction === 'back' ? await session.runtime.goBack() : await session.runtime.goForward();
    return this.updateFromSnapshot(session, snapshot);
  }

  async resizeViewport(input: {
    appSessionId: string;
    viewport: BrowserViewport;
    viewportMode: BrowserViewportMode;
    source?: BrowserInputSource;
  }): Promise<BrowserState> {
    const session = this.requireSession(input.appSessionId);
    const nextState = {
      ...session.state,
      viewport: input.viewport,
      viewportMode: input.viewportMode,
      refs: [],
      scrollResult: undefined,
    };
    await session.runtime.setViewport(input.viewport, input.source);
    session.state = nextState;
    this.emitUpdated(session.state);
    return session.state;
  }

  async click(input: {
    appSessionId: string;
    ref?: string;
    x?: number;
    y?: number;
    source?: BrowserInputSource;
  }): Promise<BrowserState> {
    const session = this.requireSession(input.appSessionId);
    const target = input.ref ? this.requireRef(session, input.ref) : undefined;
    const point = target ? centerOfBrowserRef(target) : requireBrowserPoint(input);
    const snapshot = await session.runtime.click(point.x, point.y, target?.selector, target?.ref);
    return this.updateFromSnapshot(session, snapshot);
  }

  async hover(input: {
    appSessionId: string;
    ref?: string;
    x?: number;
    y?: number;
  }): Promise<BrowserState> {
    const session = this.requireSession(input.appSessionId);
    const target = input.ref ? this.requireRef(session, input.ref) : undefined;
    const point = target ? centerOfBrowserRef(target) : requireBrowserPoint(input);
    const snapshot = await session.runtime.hover(point.x, point.y, target?.selector, target?.ref);
    return this.updateFromSnapshot(session, snapshot);
  }

  async selectOption(appSessionId: string, ref: string, value: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const target = this.requireRef(session, ref);
    const snapshot = await session.runtime.selectOption(target.selector, value, target.ref);
    return this.updateFromSnapshot(session, snapshot);
  }

  async wait(
    appSessionId: string,
    input: { text?: string; ref?: string; urlIncludes?: string; timeoutMs?: number },
  ): Promise<BrowserState> {
    return waitForBrowserCondition({
      input,
      snapshot: () => this.refresh(appSessionId),
      now: this.options.waitNow,
      delay: this.options.waitDelay,
    });
  }

  async type(appSessionId: string, text: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const snapshot = await session.runtime.type(text);
    return this.updateFromSnapshot(session, snapshot);
  }

  async keypress(appSessionId: string, key: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const snapshot = await session.runtime.keypress(key);
    return this.updateFromSnapshot(session, snapshot);
  }

  async scroll(
    appSessionId: string,
    direction: ScrollDirection,
    pixels?: number,
    _source?: BrowserInputSource,
    ref?: string,
  ): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const target = ref ? this.requireRef(session, ref) : undefined;
    const point = target ? centerOfBrowserRef(target) : undefined;
    const snapshot = await session.runtime.scroll({
      direction,
      pixels,
      x: point?.x,
      y: point?.y,
      selector: target?.selector,
      ref: target?.ref,
    });
    return this.updateFromSnapshot(session, snapshot);
  }

  async inspect(
    appSessionId: string,
    input: { ref?: string; selector?: string },
  ): Promise<BrowserElementInspection> {
    const session = this.requireSession(appSessionId);
    const selector = input.ref
      ? this.requireRef(session, input.ref).selector
      : input.selector?.trim();
    if (!selector) throw new Error('Browser inspection requires a ref or selector.');
    return session.runtime.inspect(selector, input.ref);
  }

  async network(appSessionId: string, clear = false): Promise<BrowserNetworkEvent[]> {
    return this.requireSession(appSessionId).runtime.network(clear);
  }

  async console(appSessionId: string, clear = false): Promise<BrowserConsoleEvent[]> {
    return this.requireSession(appSessionId).runtime.console(clear);
  }

  async fillCredentials(appSessionId: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    if (!session.runtime.fillCredentials) {
      throw new Error('Credential autofill is only available in the live DROIDEX browser.');
    }
    const snapshot = await session.runtime.fillCredentials();
    return this.updateFromSnapshot(session, snapshot);
  }

  async screenshot(appSessionId: string, options: BrowserScreenshotOptions = {}): Promise<string> {
    const session = this.requireSession(appSessionId);
    const base64 = await session.runtime.screenshot(options);
    const screenshotPath = await session.designReferences.saveImage(
      `screenshot-${Date.now().toString(36)}.png`,
      base64,
    );
    session.state = {
      ...session.state,
      screenshotPath,
      screenshotUrl: this.options.assetUrlFor?.(screenshotPath),
    };
    this.emitUpdated(session.state);
    return screenshotPath;
  }

  inspectPoint(appSessionId: string, x: number, y: number): BrowserElementRef | undefined {
    const session = this.requireSession(appSessionId);
    return session.state.refs.find(
      (ref) =>
        x >= ref.box.x &&
        y >= ref.box.y &&
        x <= ref.box.x + ref.box.width &&
        y <= ref.box.y + ref.box.height,
    );
  }

  async addReference(
    appSessionId: string,
    input: { anchor: DesignAnchor; detail?: DesignAnchorDetail; id?: string },
    screenshot?: DesignSelectionScreenshot,
  ): Promise<DesignReference> {
    const session = this.requireSession(appSessionId);
    return session.designReferences.add(session.state, input, screenshot);
  }

  referenceDetail(appSessionId: string, id: string): DesignReference | undefined {
    return this.sessions.get(appSessionId)?.designReferences.detail(id);
  }

  async designPrompt(input: {
    appSessionId: string;
    instruction: string;
    referenceIds: string[];
  }): Promise<{ path: string; prompt: string }> {
    const session = this.requireSession(input.appSessionId);
    return session.designReferences.prompt(input.instruction, input.referenceIds);
  }

  state(appSessionId: string): BrowserState | undefined {
    return this.sessions.get(appSessionId)?.state;
  }

  designContext(appSessionId: string): { state: BrowserState; references: DesignReference[] } {
    const session = this.requireSession(appSessionId);
    return {
      state: session.state,
      references: session.designReferences.all(),
    };
  }

  hasSession(appSessionId: string): boolean {
    return this.sessions.has(appSessionId);
  }

  async close(appSessionId: string): Promise<void> {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    this.sessions.delete(appSessionId);
    await Promise.all([session.designReferences.dispose(), session.runtime.close()]);
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const disposals = sessions.map((session) => session.designReferences.dispose());
    const results = await Promise.allSettled(disposals);
    await Promise.all(sessions.map((session) => session.runtime.close().catch(() => undefined)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  private sessionFor(
    appSessionId: string,
    viewport?: BrowserViewport,
    viewportMode?: BrowserViewportMode,
  ): ManagedBrowserSession {
    const existing = this.sessions.get(appSessionId);
    if (existing) return existing;
    const initialViewport = viewport ?? DEFAULT_BROWSER_VIEWPORT;
    const id = `browser-${appSessionId}-${randomUUID()}`;
    return this.createSession(appSessionId, id, initialViewport, {
      browserSessionId: id,
      appSessionId,
      url: 'about:blank',
      viewport: initialViewport,
      viewportMode: viewportMode ?? 'fit',
      scroll: { x: 0, y: 0 },
      refs: [],
    });
  }

  private createSession(
    appSessionId: string,
    browserSessionId: string,
    viewport: BrowserViewport,
    state: BrowserState,
  ): ManagedBrowserSession {
    const createdRuntime = this.options.runtimeFactory?.(browserSessionId, viewport, appSessionId);
    if (!createdRuntime) {
      throw new Error('Browser runtime is not configured.');
    }
    const runtime = new SerializedBrowserRuntime(createdRuntime);
    const session: ManagedBrowserSession = {
      id: browserSessionId,
      appSessionId,
      runtime,
      designReferences: new BrowserDesignReferences({
        appSessionId,
        browserSessionId,
        runtime,
        browserDataDir: this.options.browserDataDir,
        writePack: this.options.writePack,
      }),
      state,
    };
    this.sessions.set(appSessionId, session);
    return session;
  }

  private requireSession(appSessionId: string): ManagedBrowserSession {
    const session = this.sessions.get(appSessionId);
    if (!session) throw new Error('Browser session is not open yet.');
    return session;
  }

  private async updateFromSnapshot(
    session: ManagedBrowserSession,
    snapshot: BrowserSnapshot,
    viewport = session.state.viewport,
    viewportMode = session.state.viewportMode,
  ): Promise<BrowserState> {
    const nextState = {
      ...session.state,
      ...snapshot,
      viewport,
      viewportMode,
      scrollResult: snapshot.scrollResult,
      screenshotPath: snapshot.url === session.state.url ? session.state.screenshotPath : undefined,
      screenshotUrl: snapshot.url === session.state.url ? session.state.screenshotUrl : undefined,
    };
    session.state = nextState;
    await session.designReferences.navigate(snapshot.url);
    if (this.sessions.get(session.appSessionId) !== session || session.state !== nextState) {
      throw new Error('Browser state update was superseded during design-reference cleanup.');
    }
    this.emitUpdated(nextState);
    return nextState;
  }

  private requireRef(session: ManagedBrowserSession, refId: string): BrowserElementRef {
    const ref = session.state.refs.find((item) => item.ref === refId);
    if (!ref)
      throw new Error(
        `Browser ref ${refId} is not available. Refresh the browser snapshot and try again.`,
      );
    return ref;
  }

  private emitUpdated(state: BrowserState): void {
    this.options.emit?.({ type: 'browser.updated', state });
  }
}

function centerOfBrowserRef(ref: BrowserElementRef): { x: number; y: number } {
  return {
    x: Math.round(ref.box.x + ref.box.width / 2),
    y: Math.round(ref.box.y + ref.box.height / 2),
  };
}

function requireBrowserPoint(input: { x?: number; y?: number }): { x: number; y: number } {
  if (input.x === undefined || input.y === undefined) {
    throw new Error('Browser interaction requires either a ref or x/y coordinates.');
  }
  return { x: input.x, y: input.y };
}
