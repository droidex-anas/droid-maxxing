import type { NativeBrowserLoadFailed } from '../../lib/nativeBrowser';

export function BrowserLoadFailureBanner({
  failure,
  onRetry,
  onDismiss,
}: {
  failure: NativeBrowserLoadFailed;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-droid-border bg-red-500/10 px-4 py-2 text-[12px] text-droid-text-secondary">
      <span className="min-w-0 flex-1 truncate">
        Could not load {failure.url}
        {failure.error ? ` (${failure.error})` : ''}. Check that the server is running.
      </span>
      <button
        type="button"
        className="shrink-0 rounded border border-droid-border px-2 py-0.5 text-[11px] text-droid-text-muted hover:text-droid-text"
        onClick={onRetry}
      >
        Retry
      </button>
      <button
        type="button"
        className="shrink-0 rounded px-1 text-[11px] text-droid-text-muted hover:text-droid-text"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        x
      </button>
    </div>
  );
}
