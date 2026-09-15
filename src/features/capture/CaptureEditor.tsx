import { useEffect, useRef, useState } from 'react';
import { createCaptureGeneration } from './composerDestination';
import { Copy, Crop, Download, Redo2, Undo2 } from 'lucide-react';
import { captureApi, type CaptureDocument, type CaptureRecipe, type CaptureRecord } from './types';
import { drawCapture, exportCapture, loadCaptureImage } from './render';
import { analyzeCapture, type RegionCandidate } from './detection';
import { outputSize } from './geometry';
import { StyleControls } from './StyleControls';
import { CropSelector } from './CropSelector';
import { toast } from '../../lib/toast';

export function CaptureEditor({
  document: original,
  smart,
  onClose,
  onAttach,
  onSaved,
}: {
  document: CaptureDocument;
  smart: boolean;
  onClose: () => void;
  onAttach?: (id: string) => Promise<void>;
  onSaved?: () => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [recipe, setRecipe] = useState(original.recipe);
  const [undo, setUndo] = useState<CaptureRecipe[]>([]);
  const [redo, setRedo] = useState<CaptureRecipe[]>([]);
  const [cropping, setCropping] = useState(false);
  const [candidates, setCandidates] = useState<RegionCandidate[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const record = useRef<CaptureRecord>(original);
  const [lifetime] = useState(createCaptureGeneration);
  const preview = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    lifetime.invalidate();
    let cancelled = false;
    void loadCaptureImage(original.source)
      .then((value) => {
        if (!cancelled) setImage(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      lifetime.invalidate();
    };
  }, [original.source, lifetime]);
  useEffect(() => {
    if (!image || cropping) return;
    const frame = requestAnimationFrame(() => {
      try {
        if (preview.current) drawCapture(preview.current, image, recipe, 1200);
        setError('');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Could not render preview');
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [image, recipe, cropping]);
  const change = (next: CaptureRecipe) => {
    setUndo((previous) => [...previous.slice(-29), recipe]);
    setRedo([]);
    setRecipe(next);
  };
  const stepBack = () => {
    const previous = undo.at(-1);
    if (!previous) return;
    setRedo((items) => [...items, recipe]);
    setRecipe(previous);
    setUndo((items) => items.slice(0, -1));
  };
  const stepForward = () => {
    const next = redo.at(-1);
    if (!next) return;
    setUndo((items) => [...items, recipe]);
    setRecipe(next);
    setRedo((items) => items.slice(0, -1));
  };
  async function perform(action: 'save' | 'copy' | 'export' | 'attach') {
    if (!image || busyRef.current) return;
    const stamp = lifetime.stamp();
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const output = await exportCapture(image, recipe);
      if (!lifetime.isCurrent(stamp)) return;
      record.current = await captureApi().save(
        original.id,
        record.current.revision,
        recipe,
        output,
      );
      if (!lifetime.isCurrent(stamp)) return;
      onSaved?.();
      if (action === 'copy') {
        await captureApi().copy(original.id);
        if (lifetime.isCurrent(stamp)) toast.success('Full-resolution capture copied');
      } else if (action === 'export') await captureApi().export(original.id);
      else if (action === 'attach' && onAttach) {
        await onAttach(original.id);
        if (lifetime.isCurrent(stamp)) onClose();
      } else toast.success('Capture saved to Recents');
    } catch (reason) {
      if (lifetime.isCurrent(stamp))
        setError(reason instanceof Error ? reason.message : 'Could not save capture');
    } finally {
      busyRef.current = false;
      if (lifetime.isCurrent(stamp)) setBusy(false);
    }
  }
  async function saveDefault() {
    if (busyRef.current) return;
    const stamp = lifetime.stamp();
    busyRef.current = true;
    setBusy(true);
    try {
      const current = await captureApi().preferences();
      await captureApi().setPreferences({ ...current.preferences, style: recipe.style });
      if (lifetime.isCurrent(stamp))
        toast.success('Background saved as your default for future captures');
    } catch (reason) {
      if (lifetime.isCurrent(stamp))
        setError(reason instanceof Error ? reason.message : 'Could not save default');
    } finally {
      busyRef.current = false;
      if (lifetime.isCurrent(stamp)) setBusy(false);
    }
  }
  let dimensions = '';
  try {
    const size = outputSize(recipe.crop, recipe.style.padding);
    dimensions = `${String(size.width)} × ${String(size.height)} px · PNG`;
  } catch {
    dimensions = 'Composition exceeds the pixel limit';
  }
  if (cropping)
    return (
      <CropSelector
        source={original.source}
        width={original.width}
        height={original.height}
        initial={recipe.crop}
        candidates={candidates}
        smart={smart}
        onApply={(crop) => {
          change({ ...recipe, crop });
          setCropping(false);
        }}
        onCancel={() => {
          setCropping(false);
        }}
      />
    );
  return (
    <section
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'z' &&
          !(event.target instanceof HTMLInputElement)
        ) {
          event.preventDefault();
          if (!busy) {
            if (event.shiftKey) stepForward();
            else stepBack();
          }
        }
      }}
    >
      <div className="capture-editor-toolbar">
        <button
          type="button"
          className="capture-button"
          disabled={!image || busy}
          onClick={() => {
            if (image) setCandidates(smart ? analyzeCapture(image) : []);
            setCropping(true);
          }}
        >
          <Crop size={15} />
          Refine selection
        </button>
        <span className="capture-spacer" />
        <button
          type="button"
          className="capture-icon"
          title="Undo"
          aria-label="Undo capture edit"
          disabled={!undo.length || busy}
          onClick={stepBack}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className="capture-icon"
          title="Redo"
          aria-label="Redo capture edit"
          disabled={!redo.length || busy}
          onClick={stepForward}
        >
          <Redo2 size={16} />
        </button>
      </div>
      <div className="capture-editor-grid">
        <div className="capture-stage">
          {image ? (
            <canvas ref={preview} aria-label="Capture composition preview" />
          ) : (
            <p>Loading original pixels…</p>
          )}
        </div>
        <aside className="capture-inspector">
          <StyleControls
            value={recipe.style}
            disabled={busy}
            onChange={(style) => {
              change({ ...recipe, style });
            }}
          />
          <button
            type="button"
            className="capture-button capture-default"
            disabled={busy}
            onClick={() => void saveDefault()}
          >
            Make this my default
          </button>
          <p className="capture-note">
            Edits affect this capture only. Your original is retained, and future captures keep
            their saved default.
          </p>
        </aside>
      </div>
      {error && (
        <p role="alert" className="capture-error">
          {error}
        </p>
      )}
      <footer className="capture-actions">
        <span className="capture-note">{busy ? 'Rendering original pixels…' : dimensions}</span>
        <span className="capture-spacer" />
        <button
          type="button"
          className="capture-button"
          disabled={busy || !image}
          onClick={() => void perform('save')}
        >
          Save edit
        </button>
        <button
          type="button"
          className="capture-button"
          disabled={busy || !image}
          onClick={() => void perform('copy')}
        >
          <Copy size={15} />
          Copy
        </button>
        <button
          type="button"
          className="capture-button"
          disabled={busy || !image}
          onClick={() => void perform('export')}
        >
          <Download size={15} />
          PNG
        </button>
        {onAttach && (
          <button
            type="button"
            className="capture-button capture-primary"
            disabled={busy || !image}
            onClick={() => void perform('attach')}
          >
            Attach to chat
          </button>
        )}
      </footer>
    </section>
  );
}
