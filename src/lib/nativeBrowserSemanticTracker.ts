import type { BrowserNativeSnapshot } from '../types/bridge';
import {
  browserSemanticStateEquals,
  buildBrowserSemanticState,
} from './nativeBrowserSemanticState';
import type {
  BrowserSemanticDelta,
  BrowserSemanticObservation,
  BrowserSemanticObserveOptions,
  BrowserSemanticState,
} from './nativeBrowserSemanticTypes';

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function emptyDelta(revision: number): BrowserSemanticDelta {
  return {
    fromRevision: revision,
    toRevision: revision,
    reset: false,
    page: {
      urlChanged: false,
      titleChanged: false,
      scrollChanged: false,
      historyChanged: false,
      capabilitiesChanged: false,
    },
    entities: {
      added: [],
      updated: [],
      removed: [],
      orderChanged: false,
    },
  };
}

function resetDelta(
  state: BrowserSemanticState,
  fromRevision: number | null = null,
): BrowserSemanticDelta {
  return {
    fromRevision,
    toRevision: state.revision,
    reset: true,
    page: {
      urlChanged: true,
      titleChanged: true,
      scrollChanged: true,
      historyChanged: true,
      capabilitiesChanged: true,
    },
    entities: {
      added: state.entities,
      updated: [],
      removed: [],
      orderChanged: false,
    },
  };
}

export function diffBrowserSemanticStates(
  previous: BrowserSemanticState,
  current: BrowserSemanticState,
): BrowserSemanticDelta {
  const previousById = new Map(previous.entities.map((entity) => [entity.id, entity]));
  const currentById = new Map(current.entities.map((entity) => [entity.id, entity]));

  const added = current.entities.filter((entity) => !previousById.has(entity.id));
  const updated = current.entities.filter((entity) => {
    const before = previousById.get(entity.id);
    return before !== undefined && !sameValue(before, entity);
  });
  const removed = previous.entities
    .filter((entity) => !currentById.has(entity.id))
    .map((entity) => entity.id);
  const previousOrder = previous.entities.map((entity) => entity.id);
  const currentOrder = current.entities.map((entity) => entity.id);

  return {
    fromRevision: previous.revision,
    toRevision: current.revision,
    reset: false,
    page: {
      urlChanged: previous.page.url !== current.page.url,
      titleChanged: previous.page.title !== current.page.title,
      scrollChanged: !sameValue(previous.page.scroll, current.page.scroll),
      historyChanged:
        previous.page.canGoBack !== current.page.canGoBack ||
        previous.page.canGoForward !== current.page.canGoForward,
      capabilitiesChanged: !sameValue(previous.page.capabilities, current.page.capabilities),
    },
    entities: {
      added,
      updated,
      removed,
      orderChanged:
        added.length === 0 && removed.length === 0 && !sameValue(previousOrder, currentOrder),
    },
  };
}

export class BrowserSemanticStateTracker {
  private readonly historyLimit: number;
  private readonly history = new Map<number, BrowserSemanticState>();
  private currentState: BrowserSemanticState | undefined;
  private latestDelta: BrowserSemanticDelta | undefined;

  constructor(historyLimit = 20) {
    this.historyLimit = Number.isFinite(historyLimit)
      ? Math.max(1, Math.trunc(historyLimit))
      : 20;
  }

  get current(): BrowserSemanticState | undefined {
    return this.currentState;
  }

  observe(
    snapshot: BrowserNativeSnapshot,
    options: BrowserSemanticObserveOptions = {},
  ): BrowserSemanticObservation {
    const candidate = buildBrowserSemanticState(
      snapshot,
      this.currentState ? this.currentState.revision + 1 : 1,
    );

    if (this.currentState && browserSemanticStateEquals(this.currentState, candidate)) {
      this.latestDelta = emptyDelta(this.currentState.revision);
      const observation =
        options.sinceRevision === undefined
          ? { state: this.currentState, delta: this.latestDelta }
          : this.read(options.sinceRevision);
      return observation ?? {
        state: this.currentState,
        delta: emptyDelta(this.currentState.revision),
      };
    }

    const previous = this.currentState;
    this.currentState = candidate;
    this.history.set(candidate.revision, candidate);
    while (this.history.size > this.historyLimit) {
      const oldest = this.history.keys().next();
      if (oldest.done) break;
      this.history.delete(oldest.value);
    }

    const defaultDelta = previous
      ? diffBrowserSemanticStates(previous, candidate)
      : resetDelta(candidate);
    this.latestDelta = defaultDelta;

    if (options.sinceRevision !== undefined) {
      return this.read(options.sinceRevision) ?? { state: candidate, delta: defaultDelta };
    }
    return { state: candidate, delta: defaultDelta };
  }

  read(sinceRevision?: number): BrowserSemanticObservation | undefined {
    const current = this.currentState;
    if (!current) return undefined;

    if (sinceRevision === undefined) {
      return {
        state: current,
        delta: this.latestDelta ?? resetDelta(current),
      };
    }
    if (sinceRevision === current.revision) {
      return { state: current, delta: emptyDelta(current.revision) };
    }

    const previous = this.history.get(sinceRevision);
    if (!previous || sinceRevision > current.revision) {
      return { state: current, delta: resetDelta(current, sinceRevision) };
    }
    return {
      state: current,
      delta: diffBrowserSemanticStates(previous, current),
    };
  }

  reset(): void {
    this.history.clear();
    this.currentState = undefined;
    this.latestDelta = undefined;
  }
}
