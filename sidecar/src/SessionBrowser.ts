import type {
  BrowserNativeRequest,
  BrowserNativeResult,
  ClientCommand,
  ServerEvent,
} from './protocol.js';
import { errMsg } from './sessionHelpers.js';
import { boundedInt } from './values.js';
import { NativeBrowserRuntime } from './browser/NativeBrowserRuntime.js';
import type { BrowserSessionManager } from './browser/BrowserSessionManager.js';
import type { BrowserViewport } from './browser/types.js';

type Emit = (event: ServerEvent) => void;

export type SessionBrowsers = Pick<
  BrowserSessionManager,
  | 'open'
  | 'close'
  | 'closeAll'
  // Runtime retirement asks whether a session is still holding a browser.
  | 'hasSession'
  | 'reload'
  | 'refresh'
  | 'resizeViewport'
  | 'click'
  | 'type'
  | 'keypress'
  | 'scroll'
  | 'screenshot'
  | 'inspectPoint'
  | 'addReference'
  | 'designPrompt'
>;

export interface SessionBrowserDependencies {
  browsers: SessionBrowsers;
  emit: Emit;
  sendPrompt: (appSessionId: string, prompt: string) => Promise<void>;
}

const BROWSER_NATIVE_TIMEOUT_MS = boundedInt(
  process.env.DROID_CONTROL_BROWSER_NATIVE_TIMEOUT_MS,
  12_000,
  1_000,
  60_000,
);

let nativeBrowserSeq = 0;
const nextNativeBrowserRequestId = () =>
  `browser-native-${Date.now().toString(36)}-${(nativeBrowserSeq++).toString(36)}`;

interface PendingNativeBrowserRequest {
  resolve: (result: BrowserNativeResult) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class SessionBrowser {
  private readonly pendingNativeBrowserRequests = new Map<string, PendingNativeBrowserRequest>();

  constructor(private readonly d: SessionBrowserDependencies) {}

  createRuntime(
    browserSessionId: string,
    viewport: BrowserViewport,
    appSessionId: string,
  ): NativeBrowserRuntime {
    return new NativeBrowserRuntime({
      browserSessionId,
      appSessionId,
      viewport,
      request: (request) => this.requestNativeBrowser(request),
      nextRequestId: nextNativeBrowserRequestId,
    });
  }

  async open(cmd: Extract<ClientCommand, { type: 'browser.open' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, () =>
      this.d.browsers.open({
        ...cmd,
        appSessionId: this.requireBrowserAppSessionId(cmd.appSessionId),
      }),
    );
  }

  async close(cmd: Extract<ClientCommand, { type: 'browser.close' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, async () => {
      const appSessionId = this.requireBrowserAppSessionId(cmd.appSessionId);
      await this.d.browsers.close(appSessionId);
      this.d.emit({ type: 'browser.closed', appSessionId });
    });
  }

  async reload(cmd: Extract<ClientCommand, { type: 'browser.reload' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, () =>
      this.d.browsers.reload(this.requireBrowserAppSessionId(cmd.appSessionId)),
    );
  }

  async refresh(cmd: Extract<ClientCommand, { type: 'browser.refresh' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, () =>
      this.d.browsers.refresh(this.requireBrowserAppSessionId(cmd.appSessionId)),
    );
  }

  async resizeViewport(
    cmd: Extract<ClientCommand, { type: 'browser.resizeViewport' }>,
  ): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, () =>
      this.d.browsers.resizeViewport({
        ...cmd,
        appSessionId: this.requireBrowserAppSessionId(cmd.appSessionId),
      }),
    );
  }

  async click(cmd: Extract<ClientCommand, { type: 'browser.click' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, () =>
      this.d.browsers.click({
        ...cmd,
        appSessionId: this.requireBrowserAppSessionId(cmd.appSessionId),
      }),
    );
  }

  async type(cmd: Extract<ClientCommand, { type: 'browser.type' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, () =>
      this.d.browsers.type(this.requireBrowserAppSessionId(cmd.appSessionId), cmd.text),
    );
  }

  async keypress(cmd: Extract<ClientCommand, { type: 'browser.keypress' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, () =>
      this.d.browsers.keypress(this.requireBrowserAppSessionId(cmd.appSessionId), cmd.key),
    );
  }

  async scroll(cmd: Extract<ClientCommand, { type: 'browser.scroll' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, () =>
      this.d.browsers.scroll(
        this.requireBrowserAppSessionId(cmd.appSessionId),
        cmd.direction,
        cmd.pixels,
        cmd.source,
        cmd.ref,
      ),
    );
  }

  async screenshot(cmd: Extract<ClientCommand, { type: 'browser.screenshot' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, async () => {
      await this.d.browsers.screenshot(this.requireBrowserAppSessionId(cmd.appSessionId), {
        fullPage: cmd.fullPage,
        deviceScaleFactor: cmd.deviceScaleFactor,
      });
    });
  }

  async inspectPoint(cmd: Extract<ClientCommand, { type: 'browser.inspectPoint' }>): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, () => {
      const element = this.d.browsers.inspectPoint(
        this.requireBrowserAppSessionId(cmd.appSessionId),
        cmd.x,
        cmd.y,
      );
      if (!element) throw new Error('No browser element found at that point.');
    });
  }

  async addReference(
    cmd: Extract<ClientCommand, { type: 'browser.design.addReference' }>,
  ): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, async () => {
      await this.d.browsers.addReference(
        this.requireBrowserAppSessionId(cmd.appSessionId),
        {
          anchor: cmd.reference.anchor,
          detail: cmd.reference.detail,
          id: cmd.reference.id,
        },
        cmd.reference.screenshot,
      );
    });
  }

  async sendDesignPrompt(
    cmd: Extract<ClientCommand, { type: 'browser.design.sendPrompt' }>,
  ): Promise<void> {
    await this.handleBrowser(cmd.appSessionId, async () => {
      const appSessionId = this.requireBrowserAppSessionId(cmd.appSessionId);
      const { prompt } = await this.d.browsers.designPrompt({ ...cmd, appSessionId });
      await this.d.sendPrompt(appSessionId, prompt);
    });
  }

  resolveNativeBrowserRequest(result: BrowserNativeResult): void {
    const pending = this.pendingNativeBrowserRequests.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingNativeBrowserRequests.delete(result.requestId);
    if (result.ok) pending.resolve(result);
    else pending.reject(new Error(result.error ?? 'DROIDEX browser action failed.'));
  }

  private requestNativeBrowser(request: BrowserNativeRequest): Promise<BrowserNativeResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingNativeBrowserRequests.delete(request.requestId);
        reject(
          new Error(
            `DROIDEX browser did not respond to ${request.action} within ${String(BROWSER_NATIVE_TIMEOUT_MS)}ms.`,
          ),
        );
      }, BROWSER_NATIVE_TIMEOUT_MS);
      this.pendingNativeBrowserRequests.set(request.requestId, { resolve, reject, timeout });
      this.d.emit({ type: 'browser.native.request', request });
    });
  }

  private async handleBrowser(
    appSessionId: string | undefined,
    action: () => unknown,
  ): Promise<void> {
    try {
      await action();
    } catch (err) {
      const message = errMsg(err);
      this.d.emit({ type: 'browser.error', appSessionId, message });
      this.d.emit({ type: 'error', code: 'browser.error', appSessionId, message });
    }
  }

  private requireBrowserAppSessionId(appSessionId?: string): string {
    if (!appSessionId) {
      throw new Error(
        'Browser sessions are scoped to a Droid chat. Select or create a chat before opening the browser.',
      );
    }
    return appSessionId;
  }
}
