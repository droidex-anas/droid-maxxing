import { useRef, useState, type PointerEvent } from 'react';
import type { CaptureRect } from './types';
import type { RegionCandidate } from './detection';
import { clampCrop, dragCrop, snapCrop } from './geometry';

export function CropSelector({
  source,
  width,
  height,
  initial,
  candidates,
  smart,
  onApply,
  onCancel,
}: {
  source: string;
  width: number;
  height: number;
  initial: CaptureRect;
  candidates: RegionCandidate[];
  smart: boolean;
  onApply: (rect: CaptureRect) => void;
  onCancel: () => void;
}) {
  const [crop, setCrop] = useState(initial);
  const [snapped, setSnapped] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width, ((event.clientX - bounds.left) * width) / bounds.width)),
      y: Math.max(0, Math.min(height, ((event.clientY - bounds.top) * height) / bounds.height)),
    };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const raw = dragCrop(start.current, point(event), width, height);
    const next =
      smart && !event.altKey
        ? snapCrop(raw, candidates, Math.max(10, Math.min(width, height) * 0.025))
        : raw;
    setSnapped(next !== raw);
    setCrop(next);
  };
  return (
    <section className="capture-crop">
      <div className="capture-crop-help">
        <strong>
          {snapped ? 'Snapped to a detected boundary' : 'Select the part that matters'}
        </strong>
        <p>
          Drag an area, or click a detected panel. Hold Option/Alt to bypass snapping. Shift-click
          chooses a larger region. Arrow keys nudge by one original pixel.
        </p>
      </div>
      <div className="capture-crop-scroll">
        <div
          className="capture-crop-image"
          role="application"
          aria-label="Crop selection"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onApply(crop);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
              return;
            }
            const n = event.shiftKey ? 10 : 1;
            const dx = event.key === 'ArrowLeft' ? -n : event.key === 'ArrowRight' ? n : 0;
            const dy = event.key === 'ArrowUp' ? -n : event.key === 'ArrowDown' ? n : 0;
            if (dx || dy) {
              event.preventDefault();
              setCrop(
                clampCrop(
                  {
                    ...crop,
                    x: Math.max(0, Math.min(width - crop.width, crop.x + dx)),
                    y: Math.max(0, Math.min(height - crop.height, crop.y + dy)),
                  },
                  width,
                  height,
                ),
              );
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            start.current = point(event);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={move}
          onPointerUp={(event) => {
            const first = start.current;
            if (!first) return;
            const end = point(event);
            if (Math.hypot(end.x - first.x, end.y - first.y) < 5 && smart && !event.altKey) {
              const hits = candidates
                .filter(
                  (box) =>
                    end.x >= box.x &&
                    end.x <= box.x + box.width &&
                    end.y >= box.y &&
                    end.y <= box.y + box.height,
                )
                .sort((a, b) => a.width * a.height - b.width * b.height);
              const hit = event.shiftKey
                ? (hits.find((box) => box.width * box.height > crop.width * crop.height + 1) ??
                  hits.at(-1))
                : hits[0];
              if (hit) {
                setCrop(hit);
                setSnapped(true);
              }
            } else move(event);
            start.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            start.current = null;
          }}
        >
          <img src={source} alt="Original capture for selecting a region" draggable={false} />
          <div
            className="capture-selection"
            style={{
              left: `${String((crop.x / width) * 100)}%`,
              top: `${String((crop.y / height) * 100)}%`,
              width: `${String((crop.width / width) * 100)}%`,
              height: `${String((crop.height / height) * 100)}%`,
            }}
          >
            <span>
              {crop.width} × {crop.height} px
            </span>
          </div>
        </div>
      </div>
      <div className="capture-crop-values">
        {(['x', 'y', 'width', 'height'] as const).map((key) => (
          <label key={key}>
            {key}
            <input
              type="number"
              aria-label={`Crop ${key}`}
              value={crop[key]}
              min={key === 'x' || key === 'y' ? 0 : 1}
              max={key === 'x' || key === 'width' ? width : height}
              onChange={(event) => {
                if (event.target.value !== '')
                  setCrop(clampCrop({ ...crop, [key]: Number(event.target.value) }, width, height));
              }}
            />
          </label>
        ))}
      </div>
      <footer className="capture-actions">
        <button
          className="capture-button"
          onClick={() => {
            setCrop({ x: 0, y: 0, width, height });
          }}
        >
          Reset to original
        </button>
        <span className="capture-spacer" />
        <button className="capture-button" onClick={onCancel}>
          Back
        </button>
        <button
          className="capture-button capture-primary"
          onClick={() => {
            onApply(crop);
          }}
        >
          Use selection
        </button>
      </footer>
    </section>
  );
}
