import { useEffect, useRef, useState } from 'react';
import { AppWindow, Monitor, Scan, ScanLine, X } from 'lucide-react';
import { ScreenSelection } from './ScreenSelection';
import type { DesktopMode, DesktopSnapshot } from './api';

const MODES = [
  { mode: 'area', label: 'Area', icon: Scan },
  { mode: 'window', label: 'Window', icon: AppWindow },
  { mode: 'screen', label: 'Display', icon: Monitor },
  { mode: 'smart', label: 'Smart area', icon: ScanLine },
] as const;
export function DesktopPicker() {
  const toolbar = useRef<HTMLElement>(null);
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const cancel = () => {
    void window.desktopCapture.cancel().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Could not close Capture');
    });
  };
  useEffect(() => {
    let cancelled = false;
    void window.desktopCapture
      .ready()
      .then(({ theme }) => {
        toolbar.current?.focus();
        if (!cancelled)
          for (const [key, value] of Object.entries(theme))
            document.documentElement.style.setProperty(key, value);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : 'Could not open Capture');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function choose(mode: DesktopMode) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      setSnapshot(await window.desktopCapture.choose(mode));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Capture failed');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  if (snapshot) return <ScreenSelection snapshot={snapshot} onCancel={cancel} />;
  return (
    <main
      ref={toolbar}
      tabIndex={-1}
      className="desktop-picker"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <div className="desktop-toolbar" role="toolbar" aria-label="DROIDEX screen capture">
        <span className="desktop-brand" aria-hidden="true">
          D
        </span>
        <span className="desktop-divider" />
        {MODES.map(({ mode, label, icon: Icon }) => (
          <button
            type="button"
            key={mode}
            disabled={busy}
            onClick={() => {
              void choose(mode);
            }}
            title={label}
          >
            <Icon size={19} strokeWidth={1.7} />
            <span>{label}</span>
          </button>
        ))}
        <span className="desktop-divider" />
        <button
          className="desktop-close"
          type="button"
          aria-label="Cancel capture"
          onClick={cancel}
        >
          <X size={18} />
        </button>
      </div>
      <p className="desktop-hint" role={error ? 'alert' : 'status'}>
        {error ||
          (busy
            ? 'Preparing capture…'
            : 'Capture here. Your saved background is applied when attached. Esc to cancel.')}
      </p>
    </main>
  );
}
