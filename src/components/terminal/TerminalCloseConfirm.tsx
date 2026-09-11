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
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm closing terminal"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onKeepOpen();
      }}
      className="absolute inset-0 z-10 flex animate-fade-in items-center justify-center bg-droid-bg/70 p-4"
    >
      <div className="w-[280px] rounded-2xl border border-droid-border bg-droid-surface p-4">
        <p className="text-[12px] leading-relaxed text-droid-text">
          A process is still running in this terminal.
        </p>
        <div className="mt-3 flex justify-end gap-1.5 text-[12px]">
          <button
            type="button"
            autoFocus
            onClick={onKeepOpen}
            className="rounded-md px-2 py-1 leading-none text-droid-text-muted transition-colors hover:bg-droid-active hover:text-droid-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent"
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
