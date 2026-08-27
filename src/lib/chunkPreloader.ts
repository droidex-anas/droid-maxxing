import { LAZY_SURFACE_LOADERS, type LazySurface } from './lazySurfaces';

type IdleCallbackHandle = number;
type PreloadTrigger = 'intent' | 'idle';

const warmed = new Set<LazySurface>();
const intentCleanups = new Map<LazySurface, () => void>();
let idleHandle: IdleCallbackHandle | null = null;
let idleScheduled = false;

const IDLE_SURFACES: LazySurface[] = [
  'settings',
  'commandPalette',
  'files',
  'terminal',
  'review',
  'browser',
];

function preloadSurface(surface: LazySurface, trigger: PreloadTrigger): void {
  if (warmed.has(surface)) return;
  warmed.add(surface);
  void LAZY_SURFACE_LOADERS[surface]().catch(() => {
    if (trigger === 'idle') warmed.delete(surface);
  });
}

export function preloadLazySurface(surface: LazySurface): void {
  preloadSurface(surface, 'intent');
}

export function bindLazySurfaceIntent(
  surface: LazySurface,
  element: HTMLElement | null,
): () => void {
  const existing = intentCleanups.get(surface);
  existing?.();
  intentCleanups.delete(surface);

  if (!element) return () => undefined;

  const warm = () => {
    preloadLazySurface(surface);
  };
  element.addEventListener('pointerenter', warm, { passive: true });
  element.addEventListener('focusin', warm, { passive: true });

  const cleanup = () => {
    element.removeEventListener('pointerenter', warm);
    element.removeEventListener('focusin', warm);
    intentCleanups.delete(surface);
  };
  intentCleanups.set(surface, cleanup);
  return cleanup;
}

export function scheduleIdleLazyWarmup(): void {
  if (idleScheduled) return;
  idleScheduled = true;

  const run = () => {
    idleHandle = null;
    if (!idleScheduled) return;
    idleScheduled = false;
    for (const surface of IDLE_SURFACES) preloadSurface(surface, 'idle');
  };

  const requestIdle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;

  if (requestIdle) {
    idleHandle = requestIdle(run, { timeout: 4_000 });
    return;
  }

  idleHandle = setTimeout(run, 1_500) as unknown as IdleCallbackHandle;
}

export function cancelIdleLazyWarmup(): void {
  idleScheduled = false;
  if (idleHandle === null) return;
  const cancelIdle = (globalThis as { cancelIdleCallback?: (handle: number) => void })
    .cancelIdleCallback;
  if (cancelIdle) cancelIdle(idleHandle);
  else clearTimeout(idleHandle);
  idleHandle = null;
}

/** @internal Reset module state for deterministic tests. */
export function resetChunkPreloaderForTest(): void {
  for (const cleanup of intentCleanups.values()) cleanup();
  intentCleanups.clear();
  cancelIdleLazyWarmup();
  warmed.clear();
}

/** @internal Test-only visibility into warmed surfaces. */
export function warmedLazySurfacesForTest(): ReadonlySet<LazySurface> {
  return warmed;
}
