import { AlertTriangle, KeyRound } from 'lucide-react';
import { useEffect, useLayoutEffect, useReducer } from 'react';
import { isDesktop } from '../lib/desktop';
import {
  onBrowserPermissionPrompt,
  onBrowserPermissionPromptDismiss,
  type BrowserPermissionPrompt as BrowserPermissionPromptValue,
} from '../lib/browserPrompt';
import { settleBrowserPermissionPrompt } from './browserPermissionPromptCompletion';
import { browserPromptReducer, emptyBrowserPromptState } from './browserPermissionPromptState';
import { BrowserSettingsDialogFrame } from './browserSettings/BrowserSettingsDialogFrame';

export function BrowserPermissionPromptHost({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
}) {
  const [{ prompt, pending, error }, dispatch] = useReducer(
    browserPromptReducer,
    emptyBrowserPromptState,
  );
  const busy = pending !== null;

  useEffect(() => {
    if (!isDesktop()) return;
    const stopShow = onBrowserPermissionPrompt((nextPrompt) => {
      dispatch({ type: 'show', prompt: nextPrompt });
    });
    const stopDismiss = onBrowserPermissionPromptDismiss((requestId) => {
      dispatch({ type: 'dismiss', requestId });
    });
    return () => {
      stopShow();
      stopDismiss();
    };
  }, []);
  // Layout effect so the native browser view is hidden in the same commit the
  // modal mounts, before paint.
  useLayoutEffect(() => {
    onOpenChange?.(Boolean(prompt));
    return () => {
      onOpenChange?.(false);
    };
  }, [onOpenChange, prompt]);

  const choose = async (response: number) => {
    if (!prompt || busy) return;
    const selectedPrompt = prompt;
    const failure = await settleBrowserPermissionPrompt(selectedPrompt.requestId, response, {
      close: () => {
        dispatch({ type: 'choose', requestId: selectedPrompt.requestId });
      },
    });
    dispatch({ type: 'settled', requestId: selectedPrompt.requestId, error: failure });
  };

  if (!prompt) return null;
  return (
    <BrowserPermissionPromptView prompt={prompt} busy={busy} error={error} onChoose={choose} />
  );
}

function BrowserPermissionPromptView({
  prompt,
  busy,
  error = null,
  onChoose,
}: {
  prompt: BrowserPermissionPromptValue;
  busy: boolean;
  error?: string | null;
  onChoose: (response: number) => void | Promise<void>;
}) {
  let Icon = null;
  if (prompt.kind === 'credential') Icon = KeyRound;
  else if (prompt.kind === 'warning') Icon = AlertTriangle;
  const buttonLayout = prompt.buttons.length > 2 ? 'grid-cols-1' : 'grid-cols-2';

  return (
    <BrowserSettingsDialogFrame
      title={prompt.title}
      description={prompt.message}
      busy={busy}
      onClose={() => {
        void onChoose(prompt.cancelId);
      }}
      footer={
        <div className={`grid w-full ${buttonLayout} gap-2`}>
          {prompt.buttons.map((label, response) => {
            const isCancel = response === prompt.cancelId;
            return (
              <button
                key={`${String(response)}-${label}`}
                data-autofocus={isCancel ? true : undefined}
                type="button"
                disabled={busy}
                onClick={() => {
                  void onChoose(response);
                }}
                className={`rounded-xl border px-4 py-2.5 text-[12px] font-medium transition disabled:opacity-50 ${
                  isCancel
                    ? 'border-droid-border bg-droid-elevated text-droid-text-secondary hover:border-droid-border-hover'
                    : 'border-droid-accent/30 bg-droid-accent text-droid-bg hover:brightness-110'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      }
    >
      <div className="flex items-start gap-3 rounded-xl border border-droid-border bg-droid-bg/45 p-4">
        {Icon ? (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-droid-accent/25 bg-droid-accent/10">
            <Icon className="h-4 w-4 text-droid-accent" />
          </div>
        ) : null}
        <p className="text-[11.5px] leading-[18px] text-droid-text-secondary">{prompt.detail}</p>
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-4 text-red-300"
        >
          {error} Try again or cancel.
        </p>
      ) : null}
    </BrowserSettingsDialogFrame>
  );
}
