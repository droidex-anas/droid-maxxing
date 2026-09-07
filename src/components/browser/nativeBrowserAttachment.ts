import type { attachNativeBrowser } from '../../lib/nativeBrowser';

const NATIVE_ATTACH_RETRY_DELAYS_MS = [100, 300] as const;

export function createNativeBrowserAttacher(
  attach: typeof attachNativeBrowser,
): typeof attachNativeBrowser {
  const pending = new Map<string, Promise<void>>();
  return (browserSessionId, bounds, url) => {
    const existing = pending.get(browserSessionId);
    if (existing) return existing;
    const request = attach(browserSessionId, bounds, url).finally(() => {
      if (pending.get(browserSessionId) === request) pending.delete(browserSessionId);
    });
    pending.set(browserSessionId, request);
    return request;
  };
}

export function retryNativeBrowserAttach(options: {
  attach: () => Promise<void>;
  onAttached: () => void;
  onFailed: (error: unknown) => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}): () => void {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? clearTimeout;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = (attemptIndex: number) => {
    if (disposed) return;
    void options.attach().then(
      () => {
        if (!disposed) options.onAttached();
      },
      (error: unknown) => {
        if (disposed) return;
        if (attemptIndex >= NATIVE_ATTACH_RETRY_DELAYS_MS.length) {
          options.onFailed(error);
          return;
        }
        timer = schedule(() => {
          attempt(attemptIndex + 1);
        }, NATIVE_ATTACH_RETRY_DELAYS_MS[attemptIndex]);
      },
    );
  };

  attempt(0);
  return () => {
    disposed = true;
    if (timer !== undefined) cancel(timer);
  };
}
