/* global document, window */

import { INTERNAL_ATTR, element } from './dom.js';

export {
  state,
  PENCIL_COLOR,
  designRoot,
  overlay,
  penSvg,
  textHighlights,
  mount,
  positionBox,
  showBox,
  hideBox,
};

// Every mutable value the design surface shares across its modules. Keeping
// them on one object lets each module own its own writes without duplicating
// setters.
const state = {
  designMode: false,
  pencilMode: false,
  altHeld: false,
  hoverFrame: 0,
  pendingHover: null,
  hoverTarget: null,
  strokes: [],
  strokePaths: [],
  activeStroke: null,
  activePath: null,
  textDragStart: null,
  textRange: null,
  clearTimer: null,
  // True between submitting a design prompt and the main process acking that it
  // has captured the annotated region. While set, all design interactions are
  // frozen so the user cannot move/redraw/scroll mid-capture and produce a
  // screenshot that no longer matches the reference. The id makes the ack
  // request-scoped so a late ack from a superseded capture cannot clear a newer
  // pending capture.
  capturePending: false,
  pendingCaptureId: null,
  captureSeq: 0,
};

const PENCIL_COLOR = '#ff8a2a';

const designHost = document.createElement('div');
designHost.setAttribute(INTERNAL_ATTR, '1');
designHost.style.cssText = [
  'all:initial!important',
  'position:fixed!important',
  'left:0!important',
  'top:0!important',
  'width:0!important',
  'height:0!important',
  'display:block!important',
  'overflow:visible!important',
  'pointer-events:none!important',
  'z-index:2147483647!important',
].join(';');

const designRoot = designHost.attachShadow({ mode: 'closed' });

const overlay = element('div', [
  'position:fixed',
  'z-index:2147483646',
  'left:0',
  'top:0',
  'width:0',
  'height:0',
  'pointer-events:none',
  'border:2px solid #2997ff',
  'box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 0 99999px rgba(0,0,0,.08)',
  'border-radius:4px',
  'display:none',
]);

const label = element('div', [
  'position:fixed',
  'z-index:2147483646',
  'pointer-events:none',
  'max-width:360px',
  'padding:6px 8px',
  'border-radius:7px',
  'background:#1f8fff',
  'color:white',
  'font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
  'box-shadow:0 10px 28px rgba(0,0,0,.28)',
  'display:none',
]);

const textHighlights = element('div', [
  'position:fixed',
  'z-index:2147483645',
  'left:0',
  'top:0',
  'pointer-events:none',
  'display:none',
]);

const penSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
penSvg.setAttribute('width', '100%');
penSvg.setAttribute('height', '100%');
penSvg.style.cssText = [
  'position:fixed',
  'z-index:2147483646',
  'left:0',
  'top:0',
  'width:100vw',
  'height:100vh',
  'pointer-events:none',
  'display:none',
  'overflow:visible',
].join(';');

overlay.setAttribute(INTERNAL_ATTR, '1');
label.setAttribute(INTERNAL_ATTR, '1');
textHighlights.setAttribute(INTERNAL_ATTR, '1');
penSvg.setAttribute(INTERNAL_ATTR, '1');

function mount() {
  const root = document.documentElement;
  if (!root) return;
  if (!designHost.isConnected) root.appendChild(designHost);
  if (!overlay.isConnected) designRoot.appendChild(overlay);
  if (!label.isConnected) designRoot.appendChild(label);
  if (!textHighlights.isConnected) designRoot.appendChild(textHighlights);
  if (!penSvg.isConnected) designRoot.appendChild(penSvg);
}

function positionBox(node, box) {
  node.style.left = `${Math.round(box.x)}px`;
  node.style.top = `${Math.round(box.y)}px`;
  node.style.width = `${Math.round(box.width)}px`;
  node.style.height = `${Math.round(box.height)}px`;
}

function showBox(rect, text) {
  mount();
  overlay.style.display = 'block';
  positionBox(overlay, rect);
  label.style.display = 'block';
  label.textContent = text;
  label.style.left = `${Math.min(window.innerWidth - 16, Math.max(8, Math.round(rect.x)))}px`;
  label.style.top = `${Math.min(window.innerHeight - 36, Math.max(8, Math.round(rect.y - 38)))}px`;
}

function hideBox() {
  overlay.style.display = 'none';
  label.style.display = 'none';
}
