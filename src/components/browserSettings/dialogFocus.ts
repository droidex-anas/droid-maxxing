interface FocusTarget {
  focus(options?: FocusOptions): void;
}

export function createDialogFocusLifecycle(opener: FocusTarget | null) {
  let hasRestored = false;
  return {
    restore() {
      if (hasRestored) return;
      hasRestored = true;
      opener?.focus({ preventScroll: true });
    },
  };
}
