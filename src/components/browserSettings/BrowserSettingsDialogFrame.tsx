import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { pushEscapeLayer } from '../environment/usePopover';
import { createDialogFocusLifecycle } from './dialogFocus';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function BrowserSettingsDialogFrame({
  title,
  description,
  busy,
  onClose,
  children,
  footer,
}: {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const lifecycle = createDialogFocusLifecycle(
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
    );
    return () => {
      lifecycle.restore();
    };
  }, []);

  // The autofocus target can unmount between steps (Cancel gives way to Import,
  // then Done), which drops focus to the body and silences the Tab trap. Refocus
  // after any render where focus left the dialog, never stealing it back.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  });

  // Escape goes through the shared LIFO stack (see usePopover.ts) so it closes
  // only this dialog and not the settings panel behind it. Pushed once with a
  // stable callback reading the latest busy/onClose, per ThemeEditor: re-pushing
  // would lift this layer above a nested popover's.
  useEffect(() => {
    busyRef.current = busy;
  });
  useEffect(
    () =>
      pushEscapeLayer(() => {
        if (!busyRef.current) closeRef.current();
      }),
    [],
  );

  const trapFocus = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        onKeyDown={trapFocus}
        className="w-full max-w-[440px] overflow-hidden rounded-2xl border border-droid-border bg-droid-surface shadow-[0_28px_90px_rgba(0,0,0,0.58)]"
      >
        <div className="px-6 pb-5 pt-6">
          <h2
            id={titleId}
            className="text-[17px] font-semibold tracking-[-0.015em] text-droid-text"
          >
            {title}
          </h2>
          <p id={descriptionId} className="mt-1 text-[12px] leading-5 text-droid-text-muted">
            {description}
          </p>
          <div className="mt-5">{children}</div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-droid-border bg-droid-bg/30 px-6 py-4">
          {footer}
        </div>
      </div>
    </div>,
    document.body,
  );
}
