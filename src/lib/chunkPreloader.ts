import { LAZY_SURFACE_LOADERS, type LazySurface } from './lazySurfaces';

type IdleCallbackHandle = number;

const warmed = new Set<LazySurface>();
const intentCleanups = new Map<LazySurface, () => void>();
const loaderCalls = new Map<LazySurface, number>();
let idleHandle: IdleCallbackHandle | null = null;
let idleGeneration = 0;
let loaderOverride: Partial<Record<LazySurface, () => Promise<unknown>>> | null = null;

const IDLE_SURFACES: LazySurface[] = [
  'settings',
  'commandPalette',
  'files',
  'terminal',
  'review',
  'browser',
];

function loaderFor(surface: LazySurface): () => Promise<unknown> {
  return loaderOverride?.[surface] ?? LAZY_SURFACE_LOADERS[surface];
}

function preloadSurface(surface: LazySurface): void {
  if (warmed.has(surface)) return;
  warmed.add(surface);
  loaderCalls.set(surface, (loaderCalls.get(surface) ?? 0) + 1);
  void loaderFor(surface)().catch(() => {
    warmed.delete(surface);
  });
}

export function preloadLazySurface(surface: LazySurface): void {
  preloadSurface(surface);
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
  if (idleHandle !== null) return;
  const generation = idleGeneration;

  const run = () => {
    idleHandle = null;
    if (generation !== idleGeneration) return;
    for (const surface of IDLE_SURFACES) preloadSurface(surface);
  };

  const requestIdle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;

  idleHandle = requestIdle
    ? requestIdle(run, { timeout: 4_000 })
    : (setTimeout(run, 1_500) as unknown as IdleCallbackHandle);
}

export function cancelIdleLazyWarmup(): void {
  idleGeneration += 1;
  if (idleHandle === null) return;
  const handle = idleHandle;
  idleHandle = null;
  const cancelIdle = (globalThis as { cancelIdleCallback?: (handle: number) => void })
    .cancelIdleCallback;
  if (cancelIdle) cancelIdle(handle);
  else clearTimeout(handle);
}

/** @internal Reset module state for deterministic tests. */
export function __resetChunkPreloaderForTest(options?: {
  loaders?: Partial<Record<LazySurface, () => Promise<unknown>>>;
}): void {
  for (const cleanup of intentCleanups.values()) cleanup();
  intentCleanups.clear();
  cancelIdleLazyWarmup();
  warmed.clear();
  loaderCalls.clear();
  loaderOverride = options?.loaders ?? null;
  idleGeneration += 1;
}

/** @internal Count loader invocations per surface during tests. */
export function __loaderCallsForTest(): ReadonlyMap<LazySurface, number> {
  return loaderCalls;
}
