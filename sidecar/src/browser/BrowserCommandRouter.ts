import { randomUUID } from 'node:crypto';
import type { BrowserSessionManager } from './BrowserSessionManager.js';
import type {
  Autonomy,
  BrowserNativeRequest,
  BrowserNativeResult,
  ClientCommand,
  ServerEvent,
} from '../protocol.js';
import { errMsg } from '../sessionHelpers.js';
import { boundedInt } from '../values.js';

export type BrowserCommands = Pick<
  BrowserSessionManager,
  | 'open'
  | 'restore'
  | 'close'
  | 'closeAll'
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

interface BrowserCommandRouterOptions {
  browsers: BrowserCommands;
  emit: (event: ServerEvent) => void;
  getAutonomy: (appSessionId: string) => Autonomy | undefined;
  sendPrompt: (appSessionId: string, prompt: string) => Promise<void>;
}

interface PendingNativeBrowserRequest {
  appSessionId: string;
  browserSessionId: string;
  resolve: (result: BrowserNativeResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const BROWSER_NATIVE_TIMEOUT_MS = boundedInt(
  process.env.DROID_CONTROL_BROWSER_NATIVE_TIMEOUT_MS,
  12_000,
  1_000,
  60_000,
);
const BROWSER_NATIVE_INTERACTIVE_TIMEOUT_MS = 185_000;
const INTERACTIVE_BROWSER_ACTIONS = new Set<BrowserNativeRequest['action']>([
  'open',
  'goBack',
  'goForward',
  'click',
  'fillCredentials',
]);

export class BrowserCommandRouter {
  private readonly pendingNativeRequests = new Map<string, PendingNativeBrowserRequest>();

  constructor(private readonly options: BrowserCommandRouterOptions) {}

  nextNativeRequestId(): string {
    return `browser-native-${randomUUID()}`;
  }

  async handle(command: ClientCommand): Promise<boolean> {
    switch (command.type) {
      case 'browser.open':
        await this.run(command.appSessionId, () =>
          this.options.browsers.open({
            ...command,
            appSessionId: requireAppSessionId(command.appSessionId),
          }),
        );
        return true;
      case 'browser.restore': {
        const appSessionId = requireAppSessionId(command.state.appSessionId);
        await this.run(appSessionId, () =>
          this.options.browsers.restore({ ...command.state, appSessionId }),
        );
        return true;
      }
      case 'browser.close':
        await this.run(command.appSessionId, async () => {
          const appSessionId = requireAppSessionId(command.appSessionId);
          await this.options.browsers.close(appSessionId);
          this.options.emit({ type: 'browser.closed', appSessionId });
        });
        return true;
      case 'browser.reload':
        await this.run(command.appSessionId, () =>
          this.options.browsers.reload(requireAppSessionId(command.appSessionId), command.source),
        );
        return true;
      case 'browser.refresh':
        await this.run(command.appSessionId, () =>
          this.options.browsers.refresh(requireAppSessionId(command.appSessionId)),
        );
        return true;
      case 'browser.resizeViewport':
        await this.run(command.appSessionId, () =>
          this.options.browsers.resizeViewport({
            ...command,
            appSessionId: requireAppSessionId(command.appSessionId),
          }),
        );
        return true;
      case 'browser.click':
        await this.run(command.appSessionId, () =>
          this.options.browsers.click({
            ...command,
            appSessionId: requireAppSessionId(command.appSessionId),
          }),
        );
        return true;
      case 'browser.type':
        await this.run(command.appSessionId, () =>
          this.options.browsers.type(requireAppSessionId(command.appSessionId), command.text),
        );
        return true;
      case 'browser.keypress':
        await this.run(command.appSessionId, () =>
          this.options.browsers.keypress(requireAppSessionId(command.appSessionId), command.key),
        );
        return true;
      case 'browser.scroll':
        await this.run(command.appSessionId, () =>
          this.options.browsers.scroll(
            requireAppSessionId(command.appSessionId),
            command.direction,
            command.pixels,
            command.source,
            command.ref,
          ),
        );
        return true;
      case 'browser.screenshot':
        await this.run(command.appSessionId, () =>
          this.options.browsers.screenshot(requireAppSessionId(command.appSessionId), {
            fullPage: command.fullPage,
            deviceScaleFactor: command.deviceScaleFactor,
          }),
        );
        return true;
      case 'browser.inspectPoint':
        await this.run(command.appSessionId, () => {
          const element = this.options.browsers.inspectPoint(
            requireAppSessionId(command.appSessionId),
            command.x,
            command.y,
          );
          if (!element) throw new Error('No browser element found at that point.');
        });
        return true;
      case 'browser.design.addReference':
        await this.run(command.appSessionId, () =>
          this.options.browsers.addReference(
            requireAppSessionId(command.appSessionId),
            {
              anchor: command.reference.anchor,
              detail: command.reference.detail,
              id: command.reference.id,
            },
            command.reference.screenshot,
          ),
        );
        return true;
      case 'browser.design.sendPrompt':
        await this.run(command.appSessionId, async () => {
          const appSessionId = requireAppSessionId(command.appSessionId);
          const { prompt } = await this.options.browsers.designPrompt({
            ...command,
            appSessionId,
          });
          await this.options.sendPrompt(appSessionId, prompt);
        });
        return true;
      case 'browser.native.result':
        this.resolveNative(command.result);
        return true;
      default:
        return false;
    }
  }

  requestNative(request: BrowserNativeRequest): Promise<BrowserNativeResult> {
    if (request.action === 'close') {
      this.rejectPendingActions(request.appSessionId, request.browserSessionId, request.requestId);
    }
    const autonomy = this.options.getAutonomy(request.appSessionId);
    const authorizedRequest = request.action === 'close' ? request : { ...request, autonomy };
    const timeoutMs = nativeRequestTimeoutMs(request);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingNativeRequests.delete(request.requestId);
        reject(
          new Error(
            `DROIDEX browser did not respond to ${request.action} within ${String(timeoutMs)}ms.`,
          ),
        );
      }, timeoutMs);
      this.pendingNativeRequests.set(request.requestId, {
        appSessionId: request.appSessionId,
        browserSessionId: request.browserSessionId,
        resolve,
        reject,
        timeout,
      });
      this.options.emit({ type: 'browser.native.request', request: authorizedRequest });
    });
  }

  shutdown(): void {
    for (const [requestId, pending] of this.pendingNativeRequests) {
      clearTimeout(pending.timeout);
      this.pendingNativeRequests.delete(requestId);
      pending.reject(new Error('DROIDEX browser stopped before the action completed.'));
    }
  }

  private async run(appSessionId: string | undefined, action: () => unknown): Promise<void> {
    try {
      await action();
    } catch (error) {
      const message = errMsg(error);
      this.options.emit({ type: 'browser.error', appSessionId, message });
      this.options.emit({ type: 'error', code: 'browser.error', appSessionId, message });
    }
  }

  private resolveNative(result: BrowserNativeResult): void {
    const pending = this.pendingNativeRequests.get(result.requestId);
    if (!pending) return;
    if (
      result.appSessionId !== pending.appSessionId ||
      result.browserSessionId !== pending.browserSessionId
    ) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingNativeRequests.delete(result.requestId);
    if (result.ok) pending.resolve(result);
    else pending.reject(new Error(result.error ?? 'DROIDEX browser action failed.'));
  }

  private rejectPendingActions(
    appSessionId: string,
    browserSessionId: string,
    closingRequestId: string,
  ): void {
    for (const [requestId, pending] of this.pendingNativeRequests) {
      if (
        requestId === closingRequestId ||
        pending.appSessionId !== appSessionId ||
        pending.browserSessionId !== browserSessionId
      ) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingNativeRequests.delete(requestId);
      pending.reject(new Error('Browser session closed before the action completed.'));
    }
  }
}

function nativeRequestTimeoutMs(request: BrowserNativeRequest): number {
  const canPromptForAuthentication = request.action === 'keypress' && request.key === 'Enter';
  return INTERACTIVE_BROWSER_ACTIONS.has(request.action) || canPromptForAuthentication
    ? BROWSER_NATIVE_INTERACTIVE_TIMEOUT_MS
    : BROWSER_NATIVE_TIMEOUT_MS;
}

function requireAppSessionId(appSessionId?: string): string {
  if (!appSessionId) {
    throw new Error(
      'Browser sessions are scoped to a Droid chat. Select or create a chat before opening the browser.',
    );
  }
  return appSessionId;
}
