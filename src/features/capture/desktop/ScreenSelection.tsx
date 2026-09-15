import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, X } from 'lucide-react';
import { analyzeCapture, type RegionCandidate } from '../detection';
import { dragCrop, snapCrop } from '../geometry';
import type { CaptureRect } from '../types';
import type { DesktopSnapshot } from './api';

export function ScreenSelection({
  snapshot,
  onCancel,
}: {
  snapshot: DesktopSnapshot;
  onCancel: () => void;
}) {
  const [candidates, setCandidates] = useState<RegionCandidate[]>([]);
  const [hovered, setHovered] = useState<RegionCandidate[]>([]);
  const [index, setIndex] = useState(0);
  const [selection, setSelection] = useState<CaptureRect | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const active = selection ?? hovered.at(index);
  const loaded = useRef(false);
  useEffect(() => {
    surface.current?.focus();
  }, []);
  const point = (event: { clientX: number; clientY: number }) => ({
    x: Math.max(0, Math.min(snapshot.width, (event.clientX / innerWidth) * snapshot.width)),
    y: Math.max(0, Math.min(snapshot.height, (event.clientY / innerHeight) * snapshot.height)),
  });
  async function capture() {
    if (!active || busy) return;
    setBusy(true);
    try {
      await window.desktopCapture.select(active);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Selection failed');
      setBusy(false);
    }
  }
  return (
    <div
      className="desktop-selection"
      tabIndex={-1}
      ref={surface}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          event.preventDefault();
          void capture();
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          setSelection(null);
          setIndex((current) =>
            Math.max(0, Math.min(hovered.length - 1, current + (event.key === 'ArrowUp' ? 1 : -1))),
          );
        }
      }}
    >
      <img
        className="desktop-snapshot"
        src={snapshot.source}
        alt="Frozen screen to select from"
        draggable={false}
        onLoad={(event) => {
          if (loaded.current) return;
          loaded.current = true;
          const image = event.currentTarget;
          try {
            setCandidates(snapshot.smartSelection ? analyzeCapture(image) : []);
          } catch {
            setError('Suggestions are unavailable. Drag a selection instead.');
          }
          void window.desktopCapture.selectionReady().catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : 'Could not show selection');
          });
        }}
        onError={() => {
          setError('Could not decode this screen. Press Escape and try Area.');
          void window.desktopCapture.selectionReady().catch(() => undefined);
        }}
      />
      <div
        className="desktop-selection-hitbox"
        onPointerDown={(event) => {
          if (event.button !== 0 || busy) return;
          surface.current?.focus();
          start.current = point(event);
          setSelection(null);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const end = point(event);
          if (start.current) {
            const crop = dragCrop(start.current, end, snapshot.width, snapshot.height);
            setSelection(
              event.altKey ? crop : snapCrop(crop, candidates, (12 * snapshot.width) / innerWidth),
            );
            return;
          }
          if (selection) return;
          const regions = candidates
            .filter(
              (box) =>
                end.x >= box.x &&
                end.y >= box.y &&
                end.x < box.x + box.width &&
                end.y < box.y + box.height,
            )
            .sort((a, b) => a.width * a.height - b.width * b.height);
          if (regions.at(0) !== hovered.at(0)) {
            setHovered(regions);
            setIndex(0);
          }
        }}
        onPointerUp={(event) => {
          const begin = start.current;
          start.current = null;
          if (!begin || busy) return;
          const end = point(event);
          const distance =
            (Math.hypot(end.x - begin.x, end.y - begin.y) * innerWidth) / snapshot.width;
          const crop = dragCrop(begin, end, snapshot.width, snapshot.height);
          if (distance >= 3)
            setSelection(
              event.altKey ? crop : snapCrop(crop, candidates, (12 * snapshot.width) / innerWidth),
            );
          else setSelection(hovered.at(index) ?? null);
        }}
        onPointerCancel={() => {
          start.current = null;
          setSelection(null);
        }}
      />
      {active && (
        <div
          className="desktop-selection-outline"
          style={{
            left: `${String((active.x / snapshot.width) * 100)}%`,
            top: `${String((active.y / snapshot.height) * 100)}%`,
            width: `${String((active.width / snapshot.width) * 100)}%`,
            height: `${String((active.height / snapshot.height) * 100)}%`,
          }}
        >
          <span>
            {active.width} × {active.height} px
          </span>
        </div>
      )}
      <div className="desktop-selection-controls">
        <p className="desktop-hint" role={error ? 'alert' : 'status'}>
          {error || 'Frozen screen · Hover a region or drag · Option: no snapping · Enter: capture'}
        </p>
        <div className="desktop-toolbar" role="toolbar" aria-label="Refine screen selection">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setSelection(null);
            }}
          >
            <span>Reselect</span>
          </button>
          <button
            type="button"
            disabled={busy || index >= hovered.length - 1}
            onClick={() => {
              setSelection(null);
              setIndex(index + 1);
            }}
          >
            <ArrowUp size={17} />
            <span>Larger</span>
          </button>
          <button
            type="button"
            disabled={busy || index <= 0}
            onClick={() => {
              setSelection(null);
              setIndex(index - 1);
            }}
          >
            <ArrowDown size={17} />
            <span>Smaller</span>
          </button>
          <span className="desktop-divider" />
          <button
            type="button"
            className="desktop-confirm"
            disabled={!active || busy}
            onClick={() => {
              void capture();
            }}
          >
            <Check size={18} />
            <span>Capture</span>
          </button>
          <button type="button" aria-label="Cancel capture" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
