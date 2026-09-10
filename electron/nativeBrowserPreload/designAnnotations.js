/* global document, requestAnimationFrame */

import { INTERNAL_ATTR, element } from './dom.js';
import {
  PENCIL_COLOR,
  designRoot,
  mount,
  penSvg,
  positionBox,
  state,
  textHighlights,
} from './designState.js';

export {
  addAnnotation,
  clearAnnotations,
  queueReposition,
  repositionAnnotations,
  appendStrokePath,
  extendActiveStroke,
  strokeLength,
  strokesBounds,
  updateTextRange,
  clearTextHighlights,
};

let annotations = [];

let repositionQueued = false;

function addAnnotation(anchor, el) {
  clearAnnotations();
  const outline = element('div', [
    'position:fixed',
    'z-index:2147483645',
    'pointer-events:none',
    'border:2px solid #ff8a2a',
    'border-radius:4px',
    'box-shadow:0 0 0 1px rgba(0,0,0,.35)',
    'display:block',
  ]);
  const pin = element('div', [
    'position:fixed',
    'z-index:2147483645',
    'pointer-events:none',
    'min-width:18px',
    'height:18px',
    'padding:0 5px',
    'border-radius:9px',
    'background:#ff8a2a',
    'color:#111',
    'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'box-shadow:0 4px 12px rgba(0,0,0,.4)',
  ]);
  outline.setAttribute(INTERNAL_ATTR, '1');
  pin.setAttribute(INTERNAL_ATTR, '1');
  pin.textContent = '1';
  mount();
  designRoot.append(outline, pin);
  annotations.push({ anchor, el, outline, pin });
  repositionAnnotations();
}

function clearAnnotations() {
  for (const item of annotations) {
    item.outline.remove();
    item.pin.remove();
  }
  annotations = [];
  clearStrokes();
  clearTextHighlights();
}

function queueReposition() {
  if (repositionQueued) return;
  repositionQueued = true;
  requestAnimationFrame(() => {
    repositionQueued = false;
    repositionAnnotations();
  });
}

function repositionAnnotations() {
  for (const item of annotations) {
    const rect = item.el ? item.el.getBoundingClientRect() : item.anchor.box;
    const box = item.el
      ? rect
      : {
          x: item.anchor.box.x,
          y: item.anchor.box.y,
          width: item.anchor.box.width,
          height: item.anchor.box.height,
        };
    const visible = state.designMode && box.width > 0 && box.height > 0;
    item.outline.style.display = visible ? 'block' : 'none';
    item.pin.style.display = visible ? 'flex' : 'none';
    if (!visible) continue;
    positionBox(item.outline, box);
    item.pin.style.left = `${Math.round(box.x)}px`;
    item.pin.style.top = `${Math.round(Math.max(2, box.y - 20))}px`;
  }
}

// Append one <path> per stroke and only mutate the active path's `d` as the
// pointer moves. Rebuilding the whole SVG each frame made the pane flicker.
function appendStrokePath(stroke) {
  mount();
  penSvg.style.display = 'block';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', PENCIL_COLOR);
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', strokePathData(stroke));
  penSvg.appendChild(path);
  state.strokePaths.push(path);
  return path;
}

function extendActiveStroke() {
  if (state.activePath && state.activeStroke)
    state.activePath.setAttribute('d', strokePathData(state.activeStroke));
}

function strokePathData(stroke) {
  return stroke
    .map((pt, index) => `${index === 0 ? 'M' : 'L'}${Math.round(pt.x)} ${Math.round(pt.y)}`)
    .join(' ');
}

function strokeLength(stroke) {
  if (!stroke || stroke.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < stroke.length; index += 1) {
    total += Math.hypot(
      stroke[index].x - stroke[index - 1].x,
      stroke[index].y - stroke[index - 1].y,
    );
  }
  return total;
}

function strokesBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of state.strokes) {
    for (const pt of stroke) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }
  if (!Number.isFinite(minX) || maxX - minX < 4 || maxY - minY < 4) return null;
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}

function clearStrokes() {
  state.strokes = [];
  state.strokePaths = [];
  state.activeStroke = null;
  state.activePath = null;
  penSvg.textContent = '';
  penSvg.style.display = 'none';
}

function updateTextRange(start, end) {
  const from = caretAt(start.x, start.y);
  const to = caretAt(end.x, end.y);
  if (!from || !to) return;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    if (range.collapsed) {
      range.setStart(to.node, to.offset);
      range.setEnd(from.node, from.offset);
    }
  } catch {
    return;
  }
  if (range.collapsed) return;
  state.textRange = range;
  drawTextHighlights(range);
}

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

function drawTextHighlights(range) {
  mount();
  textHighlights.textContent = '';
  for (const rect of range.getClientRects()) {
    if (rect.width < 1 || rect.height < 1) continue;
    const piece = element('div', [
      'position:fixed',
      'pointer-events:none',
      'background:rgba(41,151,255,.3)',
      'border-radius:2px',
      `left:${Math.round(rect.x)}px`,
      `top:${Math.round(rect.y)}px`,
      `width:${Math.round(rect.width)}px`,
      `height:${Math.round(rect.height)}px`,
    ]);
    piece.setAttribute(INTERNAL_ATTR, '1');
    textHighlights.appendChild(piece);
  }
  textHighlights.style.display = 'block';
}

function clearTextHighlights() {
  state.textRange = null;
  textHighlights.textContent = '';
  textHighlights.style.display = 'none';
}
