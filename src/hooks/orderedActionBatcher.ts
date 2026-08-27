export interface OrderedActionBatcher<Action> {
  pushBridge(action: Action): void;
  pushBridgeBatch(actions: readonly Action[]): void;
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

  const pushBridgeBatch = (actions: readonly Action[]) => {
    if (disposed || actions.length === 0) return;
    if (timer === null) {
      if (actions.length === 1) dispatchOne(actions[0]);
      else dispatchBatch([...actions]);
      timer = schedule(flushFollowers, delayMs);
      return;
    }
    queued.push(...actions);
  };

  return {
    pushBridge(action) {
      pushBridgeBatch([action]);
    },
    pushBridgeBatch,
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
