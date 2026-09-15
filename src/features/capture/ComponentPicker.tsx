import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useObscuresNativeSurfaces } from '../../hooks/useObscuresNativeSurfaces';
import type { CaptureRect } from './types';

interface ComponentRegion {
  element: HTMLElement;
  label: string;
  rect: CaptureRect;
}
function regionsAtPoint(x: number, y: number): ComponentRegion[] {
  const target = document
    .elementsFromPoint(x, y)
    .find((node) => node instanceof HTMLElement && !node.closest('[data-capture-overlay]'));
  const regions: ComponentRegion[] = [];
  let element = target instanceof HTMLElement ? target : null;
  while (element && element !== document.body && regions.length < 10) {
    const box = element.getBoundingClientRect();
    const left = Math.max(0, box.left);
    const top = Math.max(0, box.top);
    const right = Math.min(innerWidth, box.right);
    const bottom = Math.min(innerHeight, box.bottom);
    const style = getComputedStyle(element);
    if (
      right - left >= 32 &&
      bottom - top >= 18 &&
      style.display !== 'inline' &&
      style.visibility !== 'hidden' &&
      !element.closest('[data-capture-overlay]')
    ) {
      const rect = {
        x: Math.ceil(left),
        y: Math.ceil(top),
        width: Math.floor(right) - Math.ceil(left),
        height: Math.floor(bottom) - Math.ceil(top),
      };
      const previous = regions.at(-1);
      if (previous?.rect.width !== rect.width || previous.rect.height !== rect.height)
        regions.push({
          element,
          rect,
          label:
            element.dataset.captureLabel ??
            element.getAttribute('aria-label')?.slice(0, 60) ??
            element.getAttribute('role') ??
            (element.tagName === 'ASIDE'
              ? 'Sidebar'
              : element.tagName === 'NAV'
                ? 'Navigation'
                : element.tagName === 'BUTTON'
                  ? 'Control'
                  : 'Container'),
        });
    }
    element = element.parentElement;
  }
  return regions;
}
export function ComponentPicker({
  onSelected,
  onCancel,
}: {
  onSelected: (rect: CaptureRect, label: string) => void;
  onCancel: () => void;
}) {
  useObscuresNativeSurfaces();
  const [regions, setRegions] = useState<ComponentRegion[]>([]);
  const [index, setIndex] = useState(0);
  const latest = useRef({ regions, index, onSelected, onCancel });
  latest.current = { regions, index, onSelected, onCancel };
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if ((event.target as Element).closest('[data-capture-overlay]')) return;
      const next = regionsAtPoint(event.clientX, event.clientY);
      if (next.at(0)?.element === latest.current.regions.at(0)?.element) return;
      setRegions(next);
      setIndex(0);
    };
    const choose = () => {
      const region = latest.current.regions.at(latest.current.index);
      if (region?.element.isConnected) latest.current.onSelected(region.rect, region.label);
    };
    const click = (event: MouseEvent) => {
      if ((event.target as Element).closest('[data-capture-overlay]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      choose();
    };
    const down = (event: PointerEvent) => {
      if ((event.target as Element).closest('[data-capture-overlay]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const key = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        latest.current.onCancel();
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        choose();
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Tab') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' || event.shiftKey ? -1 : 1;
        setIndex((value) =>
          Math.max(0, Math.min(latest.current.regions.length - 1, value + delta)),
        );
      }
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('click', click, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
  const active = regions.at(index);
  return createPortal(
    <div data-capture-overlay className="capture-component-overlay">
      {active && (
        <div
          className="capture-component-outline"
          style={{
            left: active.rect.x,
            top: active.rect.y,
            width: active.rect.width,
            height: active.rect.height,
          }}
        />
      )}
      <div className="capture-component-hud" role="dialog" aria-label="Choose a Droidex component">
        <strong>Choose a component</strong>
        <span>Hover, then click. ↑ larger · ↓ smaller · Esc cancel</span>
        <div>
          {regions.map((region, i) => (
            <button
              type="button"
              key={i}
              className="capture-button"
              aria-pressed={i === index}
              onClick={() => {
                setIndex(i);
              }}
            >
              {region.label}
            </button>
          ))}
        </div>
        <button type="button" className="capture-button" onClick={onCancel}>
          Cancel
        </button>
        {active && (
          <button
            type="button"
            className="capture-button capture-primary"
            onClick={() => {
              onSelected(active.rect, active.label);
            }}
          >
            Capture {active.label}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
