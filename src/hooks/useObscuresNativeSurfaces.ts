import { useLayoutEffect, useSyncExternalStore } from 'react';

/**
 * Which full-window overlays are covering the app right now.
 *
 * The browser utility pane is backed by an Electron WebContentsView: an
 * OS-level layer painted above the entire DOM, so a modal portalled to the
 * body is punched through by it no matter how high its z-index. Overlays that
 * cover the window register here while they are mounted, and `BrowserWorkspace`
 * folds the result into the `obscured` flag that hides the native view and
 * restores it on close.
 *
 * Overlays that already have store state of their own (settings, the command
 * palette, pending questions) stay there; this counter owns only the ones that
 * are plain mounted components. It counts rather than flags so stacked overlays
 * restore the surface exactly once, on the last close.
 */
let obscurerCount = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Register one overlay. The returned release is idempotent so a re-invoked
 * effect cleanup cannot drive the count below zero.
 */
export function addNativeSurfaceObscurer(): () => void {
  obscurerCount += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    obscurerCount -= 1;
    notify();
  };
}

export function areNativeSurfacesObscured(): boolean {
  return obscurerCount > 0;
}

/**
 * Hide native surfaces for as long as the calling overlay is mounted. A layout
 * effect so the view is gone in the commit that paints the overlay, instead of
 * showing through it for a frame.
 */
export function useObscuresNativeSurfaces(): void {
  useLayoutEffect(() => addNativeSurfaceObscurer(), []);
}

/**
 * The same registration as a child, for an overlay whose own component
 * outlives its `open` flag (an AnimatePresence exit keeps painting it): mount
 * this inside the animated element and it releases when that unmounts.
 */
export function NativeSurfaceObscurer(): null {
  useObscuresNativeSurfaces();
  return null;
}

/** True while any such overlay is mounted. */
export function useNativeSurfacesObscured(): boolean {
  return useSyncExternalStore(subscribe, areNativeSurfacesObscured, areNativeSurfacesObscured);
}
