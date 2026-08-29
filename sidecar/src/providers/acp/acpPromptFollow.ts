/**
 * Prompt RPC completion is settlement, not acceptance. Defer the follower so a
 * synchronously resolved prompt cannot emit turn.settled before startTurn returns.
 */
export function followAcpPrompt(
  promptPromise: Promise<unknown>,
  handlers: {
    onResult: (result: unknown) => void;
    onError: (error: unknown) => void;
  },
): void {
  queueMicrotask(() => {
    void promptPromise.then(handlers.onResult, handlers.onError);
  });
}
