export class OnceSettled<T> {
  readonly promise: Promise<T>;
  #settled = false;
  #resolve: (value: T) => void = () => undefined;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }

  get settled(): boolean {
    return this.#settled;
  }

  settle(value: T): boolean {
    if (this.#settled) {
      return false;
    }
    this.#settled = true;
    this.#resolve(value);
    return true;
  }
}

interface TrackedWaiter {
  waiter: OnceSettled<unknown>;
  cancelValue: unknown;
}

export class CursorPendingRegistry {
  readonly #waiters = new Map<string, TrackedWaiter>();
  #settledCount = 0;

  get pendingCount(): number {
    return this.#waiters.size;
  }

  get settledCount(): number {
    return this.#settledCount;
  }

  open<T>(requestId: string, cancelValue: T): OnceSettled<T> {
    const waiter = new OnceSettled<T>();
    this.#waiters.set(requestId, {
      waiter: waiter as OnceSettled<unknown>,
      cancelValue,
    });
    return waiter;
  }

  complete<T>(requestId: string, waiter: OnceSettled<T>, value: T): boolean {
    if (!waiter.settle(value)) {
      return false;
    }
    this.#settledCount += 1;
    this.#waiters.delete(requestId);
    return true;
  }

  settleAll(): number {
    let newly = 0;
    const tracked = [...this.#waiters.values()];
    this.#waiters.clear();
    for (const entry of tracked) {
      if (entry.waiter.settle(entry.cancelValue)) {
        newly += 1;
        this.#settledCount += 1;
      }
    }
    return newly;
  }
}
