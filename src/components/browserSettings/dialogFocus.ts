interface FocusTarget {
  focus(options?: FocusOptions): void;
}

export function createDialogFocusLifecycle(opener: FocusTarget | null) {
  let hasFocused = false;
  let hasRestored = false;
  return {
    focusInitial(initial: FocusTarget | null) {
      if (hasFocused) return;
      hasFocused = true;
      initial?.focus({ preventScroll: true });
    },
    restore() {
      if (hasRestored) return;
      hasRestored = true;
      opener?.focus({ preventScroll: true });
    },
  };
}
