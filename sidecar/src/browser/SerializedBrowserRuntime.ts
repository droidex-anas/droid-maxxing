import type {
  BrowserInputSource,
  BrowserRuntime,
  BrowserScrollAction,
} from './BrowserSessionManager.js';
import type {
  BrowserBox,
  BrowserConsoleEvent,
  BrowserElementInspection,
  BrowserNetworkEvent,
  BrowserScreenshotOptions,
  BrowserSnapshot,
  BrowserViewport,
} from './types.js';

const CLOSED_MESSAGE = 'Browser session closed before the action completed.';

/**
 * Gives one managed browser runtime a single ordered action stream. Closing the
 * runtime invalidates both the active action and everything already queued, so
 * late native results cannot be observed by a replacement browser session.
 */
export class SerializedBrowserRuntime implements BrowserRuntime {
  private readonly actions = new BrowserActionQueue();
  private closePromise?: Promise<void>;

  constructor(private readonly runtime: BrowserRuntime) {}

  open(url: string, source?: BrowserInputSource): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.open(url, source));
  }

  reload(source?: BrowserInputSource): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.reload(source));
  }

  goBack(): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.goBack());
  }

  goForward(): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.goForward());
  }

  setViewport(viewport: BrowserViewport, source?: BrowserInputSource): Promise<void> {
    return this.actions.run(() => this.runtime.setViewport(viewport, source));
  }

  screenshot(options?: BrowserScreenshotOptions): Promise<string> {
    return this.actions.run(() => this.runtime.screenshot(options));
  }

  capture(box?: BrowserBox, options?: BrowserScreenshotOptions): Promise<string> {
    return this.actions.run(() => this.runtime.capture(box, options));
  }

  snapshot(): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.snapshot());
  }

  click(x: number, y: number, selector?: string, ref?: string): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.click(x, y, selector, ref));
  }

  hover(x: number, y: number, selector?: string, ref?: string): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.hover(x, y, selector, ref));
  }

  selectOption(selector: string, value: string, ref?: string): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.selectOption(selector, value, ref));
  }

  type(text: string): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.type(text));
  }

  keypress(key: string): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.keypress(key));
  }

  scroll(input: BrowserScrollAction): Promise<BrowserSnapshot> {
    return this.actions.run(() => this.runtime.scroll(input));
  }

  inspect(selector: string, ref?: string): Promise<BrowserElementInspection> {
    return this.actions.run(() => this.runtime.inspect(selector, ref));
  }

  network(clear?: boolean): Promise<BrowserNetworkEvent[]> {
    return this.actions.run(() => this.runtime.network(clear));
  }

  console(clear?: boolean): Promise<BrowserConsoleEvent[]> {
    return this.actions.run(() => this.runtime.console(clear));
  }

  fillCredentials(): Promise<BrowserSnapshot> {
    const fillCredentials = this.runtime.fillCredentials?.bind(this.runtime);
    if (!fillCredentials) {
      return Promise.reject(
        new Error('Credential autofill is only available in the live DROIDEX browser.'),
      );
    }
    return this.actions.run(fillCredentials);
  }

  close(): Promise<void> {
    this.actions.invalidate();
    // Close bypasses the action tail intentionally: waiting for a hung native
    // action would leave its WebContents alive. The queue's closed error rejects
    // every late result, and each replacement gets a new browserSessionId, so
    // the old runtime can neither publish state nor target the replacement.
    this.closePromise ??= Promise.resolve().then(() => this.runtime.close());
    return this.closePromise;
  }
}

interface PendingAction {
  reject: (error: Error) => void;
}

class BrowserActionQueue {
  private tail: Promise<void> = Promise.resolve();
  private closedError?: Error;
  private readonly pending = new Set<PendingAction>();

  run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const queued = this.tail.then(async () => {
      this.assertOpen();
      const value = await action();
      this.assertOpen();
      return value;
    });
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );

    return new Promise<T>((resolve, reject) => {
      const pending = { reject };
      this.pending.add(pending);
      void queued.then(
        (value) => {
          if (!this.pending.delete(pending)) return;
          resolve(value);
        },
        (error: unknown) => {
          if (!this.pending.delete(pending)) return;
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  invalidate(): void {
    if (this.closedError) return;
    this.closedError = new Error(CLOSED_MESSAGE);
    for (const action of this.pending) action.reject(this.closedError);
    this.pending.clear();
  }

  private assertOpen(): void {
    if (this.closedError) throw this.closedError;
  }
}
