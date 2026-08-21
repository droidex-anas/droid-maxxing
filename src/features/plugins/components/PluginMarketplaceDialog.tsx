import { LoaderCircle, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function PluginMarketplaceDialog({
  open,
  busy,
  error,
  onClose,
  onAdd,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onAdd: (source: string) => void;
}) {
  const [source, setSource] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSource('');
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  const submit = () => {
    const value = source.trim();
    if (!value || busy) return;
    onAdd(value);
  };

  return (
    <div
      className="absolute inset-0 z-[80] flex items-center justify-center bg-black/45 px-5 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-marketplace-title"
        className="w-full max-w-[460px] rounded-[20px] border border-droid-border bg-droid-surface p-5 shadow-[0_28px_90px_rgba(0,0,0,0.42)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="plugin-marketplace-title" className="text-[16px] font-semibold text-droid-text">
              Add marketplace
            </h2>
            <p className="mt-1 max-w-sm text-[11.5px] leading-5 text-droid-text-muted">
              Add a Factory or Claude-compatible plugin repository once at user scope. DROIDEX keeps
              one marketplace record instead of copying it into each workspace.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-lg p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-5 block text-[11px] font-medium text-droid-text-secondary">
          Repository or local path
          <input
            ref={inputRef}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            placeholder="https://github.com/your-org/agent-plugins"
            className="mt-2 w-full rounded-xl border border-droid-border bg-droid-field px-3.5 py-2.5 text-[12px] text-droid-text outline-none transition-colors placeholder:text-droid-text-muted/45 focus:border-droid-border-hover"
          />
        </label>

        {error && (
          <div className="mt-3 rounded-xl border border-droid-red/25 bg-droid-red/8 px-3 py-2 text-[11px] leading-5 text-droid-red">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-[11.5px] font-medium text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || source.trim().length === 0}
            className="inline-flex min-w-[124px] items-center justify-center gap-1.5 rounded-lg bg-droid-text px-3 py-2 text-[11.5px] font-semibold text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {busy ? 'Adding…' : 'Add marketplace'}
          </button>
        </div>
      </section>
    </div>
  );
}
