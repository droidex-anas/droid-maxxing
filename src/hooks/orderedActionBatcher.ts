export interface OrderedActionBatcher<Action> {
  pushBridge(action: Action): void;
  dispatchLocal(action: Action): void;
  dispose(): void;
}

export function createOrderedActionBatcher<Action, Timer>({
  dispatchOne,
  dispatchBatch,
  schedule,
  cancel,
  delayMs,
}: {
  dispatchOne: (action: Action) => void;
  dispatchBatch: (actions: Action[]) => void;
  schedule: (callback: () => void, delayMs: number) => Timer;
  cancel: (timer: Timer) => void;
  delayMs: number;
}): OrderedActionBatcher<Action> {
  let queued: Action[] = [];
  let timer: Timer | null = null;
  let disposed = false;

  const flushFollowers = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    if (queued.length === 0) return;
    const actions = queued;
    queued = [];
    dispatchBatch(actions);
  };

  return {
    pushBridge(action) {
      if (disposed) return;
      if (timer === null) {
        dispatchOne(action);
        timer = schedule(flushFollowers, delayMs);
        return;
      }
      queued.push(action);
    },
    dispatchLocal(action) {
      flushFollowers();
      dispatchOne(action);
    },
    dispose() {
      if (disposed) return;
      flushFollowers();
      disposed = true;
    },
  };
}
