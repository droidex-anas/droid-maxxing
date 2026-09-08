import type { attachNativeBrowser } from '../../lib/nativeBrowser';

const NATIVE_ATTACH_RETRY_DELAYS_MS = [100, 300] as const;

export function createNativeBrowserAttacher(
  attach: typeof attachNativeBrowser,
): typeof attachNativeBrowser {
  // Main bumps an attachment revision per attach, so a request superseded by a
  // different target resolves as a no-op. Only the latest target may be shared.
  let current: { id: string; request: Promise<void> } | null = null;
  return (browserSessionId, bounds, url) => {
    if (current?.id === browserSessionId) return current.request;
    const request = attach(browserSessionId, bounds, url).finally(() => {
      if (current?.request === request) current = null;
    });
    current = { id: browserSessionId, request };
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
