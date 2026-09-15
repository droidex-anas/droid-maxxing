import { playCaptureClick } from './captureSound';
import './capture.css';
import { useEffect, useRef, useState } from 'react';
import { createCaptureGeneration } from './composerDestination';
import { AppWindow, Scan, Monitor, Upload, MousePointer2 } from 'lucide-react';
import { CaptureFrame } from './CaptureFrame';
import { CaptureEditor } from './CaptureEditor';
import { ComponentPicker } from './ComponentPicker';
import {
  captureApi,
  type CaptureDocument,
  type CaptureMode,
  type CaptureRect,
  type CaptureStatus,
} from './types';
import { exportCapture, importCaptureFile, loadCaptureImage } from './render';
import { backgroundFor } from './presets';

const afterPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        resolve();
      }),
    ),
  );

export default function CaptureDialog({
  captureId,
  onClose,
  onAttach,
  onSaved,
}: {
  captureId?: string;
  onClose: () => void;
  onAttach?: (id: string) => Promise<void>;
  onSaved?: () => void;
}) {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [phase, setPhase] = useState<'choose' | 'component' | 'hidden' | 'working' | 'editing'>(
    captureId ? 'working' : 'choose',
  );
  const [document, setDocument] = useState<CaptureDocument | null>(null);
  const [error, setError] = useState('');
  const [editFirst, setEditFirst] = useState(!onAttach);
  const [lifetime] = useState(createCaptureGeneration);
  const busy = useRef(false);
  const request = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    lifetime.invalidate();
    let cancelled = false;
    void captureApi()
      .preferences()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    if (captureId)
      void captureApi()
        .read(captureId)
        .then((value) => {
          if (!cancelled) {
            setDocument(value);
            setPhase('editing');
          }
        })
        .catch((reason: unknown) => {
          if (!cancelled) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setPhase('choose');
          }
        });
    return () => {
      cancelled = true;
      lifetime.invalidate();
      if (request.current)
        void captureApi()
          .cancel(request.current)
          .catch(() => undefined);
    };
  }, [captureId, lifetime]);
  async function accept(original: CaptureDocument, openEditor: boolean, stamp: number) {
    if (!lifetime.isCurrent(stamp)) return;
    setDocument(original);
    if (openEditor || !onAttach) {
      setPhase('editing');
      return;
    }
    const image = await loadCaptureImage(original.source);
    if (!lifetime.isCurrent(stamp)) return;
    const output = await exportCapture(image, original.recipe);
    if (!lifetime.isCurrent(stamp)) return;
    await captureApi().save(original.id, original.revision, original.recipe, output);
    if (!lifetime.isCurrent(stamp)) return;
    onSaved?.();
    await onAttach(original.id);
    if (lifetime.isCurrent(stamp)) onClose();
  }
  async function take(mode: CaptureMode, rect?: CaptureRect, title?: string) {
    if (busy.current || !status) return;
    const stamp = lifetime.stamp();
    busy.current = true;
    setError('');
    setPhase(mode === 'component' ? 'hidden' : 'working');
    try {
      await afterPaint();
      if (!lifetime.isCurrent(stamp)) return;
      const requestId = crypto.randomUUID();
      request.current = requestId;
      const original = await captureApi().take({ requestId, mode, rect, title });
      request.current = null;
      if (!lifetime.isCurrent(stamp)) return;
      if (!original) {
        onClose();
        return;
      }
      if (status.preferences.sound) void playCaptureClick().catch(() => undefined);
      setPhase('working');
      await accept(original, editFirst, stamp);
    } catch (reason) {
      if (lifetime.isCurrent(stamp)) {
        setError(reason instanceof Error ? reason.message : 'Capture failed');
        setPhase('choose');
      }
    } finally {
      busy.current = false;
    }
  }
  async function importFile(file: File) {
    if (busy.current) return;
    const stamp = lifetime.stamp();
    busy.current = true;
    setPhase('working');
    setError('');
    try {
      const source = await importCaptureFile(file);
      if (!lifetime.isCurrent(stamp)) return;
      const original = await captureApi().import(source, file.name.replace(/\.[^.]+$/, ''));
      await accept(original, true, stamp);
    } catch (reason) {
      if (lifetime.isCurrent(stamp)) {
        setError(reason instanceof Error ? reason.message : 'Import failed');
        setPhase('choose');
      }
    } finally {
      busy.current = false;
    }
  }
  if (phase === 'component')
    return (
      <ComponentPicker
        onSelected={(rect, title) => void take('component', rect, title)}
        onCancel={onClose}
      />
    );
  if (phase === 'hidden') return null;
  return (
    <CaptureFrame
      title={
        phase === 'editing'
          ? (document?.title ?? 'Edit capture')
          : 'Capture something worth sharing'
      }
      onClose={onClose}
    >
      {phase === 'editing' && document ? (
        <CaptureEditor
          key={document.id}
          document={document}
          smart={status?.preferences.smartSelection ?? true}
          onClose={onClose}
          onAttach={onAttach}
          onSaved={onSaved}
        />
      ) : phase === 'working' ? (
        <div className="capture-working" role="status">
          <span className="capture-pulse" />
          <h3>{captureId ? 'Opening original…' : 'Capturing original pixels…'}</h3>
          <p>
            Escape cancels the native picker. Your chat stays untouched until the attachment is
            ready.
          </p>
          <button type="button" className="capture-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="capture-picker-content">
          <p className="capture-note">
            Snip, frame, and return to your draft. Nothing is sent automatically.
          </p>
          <div className="capture-modes">
            <button
              type="button"
              disabled={!status?.nativeAvailable}
              onClick={() => void take('area')}
            >
              <Scan />
              <strong>Area</strong>
              <span>Drag anywhere on screen</span>
            </button>
            <button
              type="button"
              disabled={!status?.nativeAvailable}
              onClick={() => void take('window')}
            >
              <AppWindow />
              <strong>Window</strong>
              <span>Clean native window capture</span>
            </button>
            <button
              type="button"
              disabled={!status?.nativeAvailable}
              onClick={() => void take('screen')}
            >
              <Monitor />
              <strong>Full screen</strong>
              <span>Primary display · original pixels</span>
            </button>
            <button
              type="button"
              disabled={!status}
              onClick={() => {
                setPhase('component');
              }}
            >
              <MousePointer2 />
              <strong>Droidex component</strong>
              <span>Point, step into a section, click</span>
            </button>
          </div>
          {status && !status.nativeAvailable && (
            <p className="capture-note">
              Desktop area/window capture requires macOS. Component capture and image import are
              available here.
            </p>
          )}
          <div className="capture-picker-footer">
            <button
              type="button"
              className="capture-button"
              disabled={!status}
              onClick={() => input.current?.click()}
            >
              <Upload size={16} />
              Import image
            </button>
            <input
              ref={input}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
                event.target.value = '';
              }}
            />
            <span className="capture-spacer" />
            <label className="capture-check">
              <input
                type="checkbox"
                checked={editFirst}
                onChange={(event) => {
                  setEditFirst(event.target.checked);
                }}
              />
              Refine before attaching
            </label>
          </div>
          {status && (
            <p className="capture-note">
              Default background:{' '}
              <strong>{backgroundFor(status.preferences.style.preset).name}</strong>. Change it in
              Settings → Screenshots, or edit any capture later.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="capture-error" role="alert">
          {error}
        </p>
      )}
    </CaptureFrame>
  );
}
