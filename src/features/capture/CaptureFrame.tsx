import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useObscuresNativeSurfaces } from '../../hooks/useObscuresNativeSurfaces';

export function CaptureFrame({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useObscuresNativeSurfaces();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className="capture-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="capture-dialog"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
          if (event.key === 'Tab') {
            const nodes = Array.from(
              ref.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
              ) ?? [],
            ).filter((node) => node.getClientRects().length > 0);
            const index = nodes.indexOf(document.activeElement as HTMLElement);
            if (nodes.length) {
              event.preventDefault();
              nodes[
                index < 0
                  ? event.shiftKey
                    ? nodes.length - 1
                    : 0
                  : (index + (event.shiftKey ? nodes.length - 1 : 1)) % nodes.length
              ].focus();
            }
          }
        }}
      >
        <header className="capture-header">
          <div>
            <span className="capture-eyebrow">DROIDEX</span>
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="capture-icon"
            aria-label="Close capture"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
