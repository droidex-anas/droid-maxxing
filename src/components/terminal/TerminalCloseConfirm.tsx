import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ── Closing a shell that still has something running asks here, over the
   terminal the user is looking at, rather than in a popover hanging off the
   tab strip. Escape keeps the terminal, matching the quiet button. ── */
export function TerminalCloseConfirm({
  onKeepOpen,
  onStopAndClose,
}: {
  onKeepOpen: () => void;
  onStopAndClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // aria-modal contract: Tab must cycle inside the dialog, same wrap logic as
  // WorktreeRemovalDialog. This one overlays a live terminal, so without it
  // Tab walks straight back into the shell behind the scrim.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onKeepOpen();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || active === dialog || !dialog.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Confirm closing terminal"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-10 flex animate-fade-in items-center justify-center bg-droid-bg/70 p-4"
    >
      <div className="w-[280px] rounded-2xl border border-droid-border bg-droid-surface p-4 shadow-2xl shadow-black/50">
        <p className="text-[12px] leading-relaxed text-droid-text">
          A process is still running in this terminal.
        </p>
        <div className="mt-3 flex justify-end gap-1.5 text-[12px]">
          <button
            type="button"
            autoFocus
            onClick={onKeepOpen}
            className="rounded-md px-2 py-1 leading-none text-droid-text-muted transition-colors hover:bg-droid-active hover:text-droid-text focus:bg-droid-active focus:text-droid-text focus:outline-none"
          >
            Keep
          </button>
          <button
            type="button"
            onClick={onStopAndClose}
            className="rounded-md bg-droid-elevated px-2 py-1 leading-none text-droid-text transition-colors hover:bg-droid-active focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent"
          >
            Stop and close
          </button>
        </div>
      </div>
    </div>
  );
}
