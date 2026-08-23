import { randomUUID } from 'node:crypto';
import type { BrowserNativeRequest, BrowserNativeResult } from '../protocol.js';
import type { BrowserInputSource, BrowserRuntime } from './BrowserSessionManager.js';
import type {
  BrowserBox,
  BrowserElementInspection,
  BrowserConsoleEvent,
  BrowserNetworkEvent,
  BrowserScreenshotOptions,
  BrowserSnapshot,
  BrowserViewport,
  ScrollDirection,
} from './types.js';

export interface NativeBrowserRuntimeOptions {
  browserSessionId: string;
  appSessionId: string;
  viewport: BrowserViewport;
  request: (request: BrowserNativeRequest) => Promise<BrowserNativeResult>;
  nextRequestId?: () => string;
}

export class NativeBrowserRuntime implements BrowserRuntime {
  private viewport: BrowserViewport;
  private lastSnapshot: BrowserSnapshot = {
    url: 'about:blank',
    scroll: { x: 0, y: 0 },
    refs: [],
  };

  constructor(private readonly options: NativeBrowserRuntimeOptions) {
    this.viewport = options.viewport;
  }

  async open(url: string, source?: BrowserInputSource): Promise<BrowserSnapshot> {
    return this.snapshotFrom(await this.send({ action: 'open', url, source }));
  }

  async reload(source?: BrowserInputSource): Promise<BrowserSnapshot> {
    return this.navigationSnapshotFrom(await this.send({ action: 'reload', source }));
  }

  async goBack(): Promise<BrowserSnapshot> {
    return this.navigationSnapshotFrom(await this.send({ action: 'goBack' }));
  }

  async goForward(): Promise<BrowserSnapshot> {
    return this.navigationSnapshotFrom(await this.send({ action: 'goForward' }));
  }

  async setViewport(viewport: BrowserViewport, source?: BrowserInputSource): Promise<void> {
    const result = await this.send({ action: 'resize', viewport, source });
    if (!result.ok) throw new Error(result.error ?? 'Native browser resize failed.');
    this.viewport = viewport;
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<string> {
    return this.capture(undefined, options);
  }

  async capture(box?: BrowserBox, options: BrowserScreenshotOptions = {}): Promise<string> {
    const result = await this.send({
      action: 'capture',
      box,
      fullPage: options.fullPage,
      deviceScaleFactor: options.deviceScaleFactor,
    });
    if (!result.ok) throw new Error(result.error ?? 'Native browser capture failed.');
    if (!result.image) throw new Error('Native browser did not return a captured image.');
    return result.image;
  }

  async snapshot(): Promise<BrowserSnapshot> {
    return this.snapshotFrom(await this.send({ action: 'snapshot' }));
  }

  async click(x: number, y: number, selector?: string): Promise<BrowserSnapshot> {
    return this.action({ action: 'click', x, y, selector });
  }

  async hover(x: number, y: number, selector?: string): Promise<BrowserSnapshot> {
    return this.action({ action: 'hover', x, y, selector });
  }

  async selectOption(selector: string, value: string): Promise<BrowserSnapshot> {
    return this.action({ action: 'selectOption', selector, text: value });
  }

  async type(text: string): Promise<BrowserSnapshot> {
    return this.action({ action: 'type', text });
  }

  async keypress(key: string): Promise<BrowserSnapshot> {
    return this.action({ action: 'keypress', key });
  }

  async scroll(
    direction: ScrollDirection,
    pixels?: number,
    x?: number,
    y?: number,
  ): Promise<BrowserSnapshot> {
    return this.action({ action: 'scroll', direction, pixels, x, y });
  }

  async inspect(selector: string): Promise<BrowserElementInspection> {
    const result = await this.send({ action: 'inspect', selector });
    if (!result.ok) throw new Error(result.error ?? 'Native browser inspection failed.');
    if (!result.inspection) throw new Error('Native browser returned no element inspection.');
    return result.inspection;
  }

  async network(clear = false): Promise<BrowserNetworkEvent[]> {
    const result = await this.send({ action: 'network', clearNetworkLog: clear });
    if (!result.ok) throw new Error(result.error ?? 'Native browser network inspection failed.');
    return result.networkEvents ?? [];
  }

  async console(clear = false): Promise<BrowserConsoleEvent[]> {
    const result = await this.send({ action: 'console', clearConsoleLog: clear });
    if (!result.ok) throw new Error(result.error ?? 'Native browser console inspection failed.');
    return result.consoleEvents ?? [];
  }

  async fillCredentials(): Promise<BrowserSnapshot> {
    return this.snapshotFrom(await this.send({ action: 'fillCredentials' }));
  }

  async close(): Promise<void> {
    await this.send({ action: 'close' }).catch(() => {});
  }

  private async action(
    input: Omit<
      BrowserNativeRequest,
      'requestId' | 'appSessionId' | 'browserSessionId' | 'viewport'
    >,
  ): Promise<BrowserSnapshot> {
    const result = await this.send(input);
    return this.snapshotFrom(result);
  }

  private send(
    input: Omit<BrowserNativeRequest, 'requestId' | 'appSessionId' | 'browserSessionId'>,
  ): Promise<BrowserNativeResult> {
    return this.options.request({
      requestId: this.options.nextRequestId?.() ?? `native-${randomUUID()}`,
      appSessionId: this.options.appSessionId,
      browserSessionId: this.options.browserSessionId,
      viewport: this.viewport,
      ...input,
    });
  }

  private snapshotFrom(result: BrowserNativeResult): BrowserSnapshot {
    if (!result.ok) throw new Error(result.error ?? 'Native browser action failed.');
    if (result.snapshot && isBrowserPageUrl(result.snapshot.url)) {
      this.lastSnapshot = result.snapshot;
      return this.lastSnapshot;
    }
    throw new Error('Native browser action completed without a fresh page snapshot.');
  }

  private navigationSnapshotFrom(result: BrowserNativeResult): BrowserSnapshot {
    if (!result.ok) throw new Error(result.error ?? 'Native browser navigation failed.');
    if (!result.snapshot) {
      throw new Error('Native browser navigation completed without a fresh page snapshot.');
    }
    if (!isBrowserPageUrl(result.snapshot.url)) {
      throw new Error('Native browser navigation returned an invalid page snapshot.');
    }
    this.lastSnapshot = result.snapshot;
    return this.lastSnapshot;
  }
}

function isBrowserPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}
