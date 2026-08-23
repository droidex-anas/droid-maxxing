import { Loader2 } from 'lucide-react';
import { BrowserSettingsDialogFrame } from './BrowserSettingsDialogFrame';

export function BrowserConfirmDialog({
  title,
  description,
  actionLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  actionLabel: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <BrowserSettingsDialogFrame
      title={title}
      description={description}
      busy={busy}
      onClose={onCancel}
      footer={
        <>
          <button
            data-autofocus
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-[12px] font-medium text-droid-text-secondary hover:bg-droid-elevated/70 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="flex min-w-[112px] items-center justify-center gap-2 rounded-lg bg-red-500/15 px-3.5 py-2 text-[12px] font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {actionLabel}
          </button>
        </>
      }
    >
      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4 text-[11.5px] leading-5 text-droid-text-secondary">
        This action changes the shared DROIDEX browser profile and applies to every chat.
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[11.5px] text-red-400">
          {error}
        </p>
      )}
    </BrowserSettingsDialogFrame>
  );
}
