/* global window, clearTimeout, setTimeout */

import { ipcRenderer } from 'electron';
import { INTERNAL_ATTR, clamp, cleanPrompt, element } from './dom.js';
import { designRoot, hideBox, mount, state } from './designState.js';
import { clearAnnotations } from './designAnnotations.js';

export { finishCapture, promptVisible, showPrompt, hidePrompt, cancelDesign };

let promptBox = null;

let promptInput = null;

let promptTag = null;

let promptSend = null;

let promptSelection = null;

function finishCapture() {
  if (state.clearTimer) {
    clearTimeout(state.clearTimer);
    state.clearTimer = null;
  }
  state.capturePending = false;
  state.pendingCaptureId = null;
  clearAnnotations();
}

function promptVisible() {
  return Boolean(promptBox && promptBox.style.display === 'block');
}

function showPrompt(selection) {
  promptSelection = selection;
  mountPrompt();
  hideBox();
  if (promptTag) promptTag.textContent = selection.anchor.label || selection.anchor.id;
  promptInput.value = '';
  syncPromptSend();
  positionPrompt(selection.anchor.box);
  promptBox.style.display = 'block';
  window.setTimeout(() => promptInput.focus({ preventScroll: true }), 0);
}

function hidePrompt() {
  promptSelection = null;
  if (promptBox) promptBox.style.display = 'none';
}

// Cancel fully resets the design turn: close the composer AND wipe the
// pending selection box plus any sketch state.strokes / text highlights, leaving the
// pane armed for a fresh selection. Hiding the composer alone left the
// annotations on screen, which looked like the cancel button did nothing.
function cancelDesign() {
  if (state.clearTimer) {
    clearTimeout(state.clearTimer);
    state.clearTimer = null;
  }
  state.capturePending = false;
  state.pendingCaptureId = null;
  hidePrompt();
  hideBox();
  clearAnnotations();
}

function mountPrompt() {
  if (!promptBox) {
    promptBox = element('form', [
      'position:fixed',
      'z-index:2147483647',
      'display:none',
      'width:min(440px,calc(100vw - 24px))',
      'background:rgba(18,18,18,.96)',
      'color:#f4f4f5',
      'border:1px solid rgba(255,255,255,.16)',
      'border-radius:12px',
      'box-shadow:0 20px 60px rgba(0,0,0,.42)',
      'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'padding:8px',
      'box-sizing:border-box',
      'pointer-events:auto',
    ]);
    promptBox.setAttribute(INTERNAL_ATTR, '1');
    const row = element('div', ['display:flex', 'align-items:center', 'gap:8px']);
    promptTag = element('div', [
      'max-width:160px',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'color:#9ca3af',
      'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
    ]);
    promptTag.textContent = '@ref';
    promptInput = element('input', [
      'flex:1',
      'min-width:0',
      'height:32px',
      'border:0',
      'outline:0',
      'background:transparent',
      'color:#f4f4f5',
      'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    ]);
    promptInput.placeholder = 'Describe the change';
    promptInput.addEventListener('input', syncPromptSend);
    promptSend = element('button', [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'width:30px',
      'height:30px',
      'border:0',
      'border-radius:999px',
      'background:#f4f4f5',
      'color:#111',
      'cursor:pointer',
      'flex:0 0 auto',
      'transition:opacity .15s ease,background .15s ease',
    ]);
    promptSend.type = 'submit';
    promptSend.title = 'Send to Droid';
    promptSend.innerHTML = sendIconSvg();
    const close = element('button', [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'width:28px',
      'height:28px',
      'border:0',
      'border-radius:7px',
      'background:transparent',
      'color:#9ca3af',
      'cursor:pointer',
      'flex:0 0 auto',
    ]);
    close.type = 'button';
    close.title = 'Cancel';
    close.innerHTML = closeIconSvg();
    row.append(promptTag, promptInput, promptSend, close);
    promptBox.append(row);
    promptBox.addEventListener('submit', (event) => {
      event.preventDefault();
      const instruction = cleanPrompt(promptInput.value);
      if (!instruction || !promptSelection) return;
      // Hide the composer but keep state.strokes/highlights visible: the main
      // process captures the annotated region before acking, then the
      // 'native-browser-design-prompt-sent' handler clears everything.
      state.captureSeq += 1;
      const captureId = state.captureSeq;
      state.pendingCaptureId = captureId;
      state.capturePending = true;
      sendDesignPrompt({ selection: promptSelection, instruction, captureId });
      hidePrompt();
      if (state.clearTimer) clearTimeout(state.clearTimer);
      state.clearTimer = setTimeout(() => {
        if (state.pendingCaptureId === captureId) finishCapture();
      }, 4000);
    });
    promptBox.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelDesign();
      }
    });
    close.addEventListener('click', cancelDesign);
    for (const type of ['mousedown', 'mouseup', 'click', 'mousemove', 'wheel']) {
      promptBox.addEventListener(type, (event) => event.stopPropagation(), true);
    }
  }
  mount();
  if (!promptBox.isConnected) designRoot.appendChild(promptBox);
}

function syncPromptSend() {
  if (!promptSend || !promptInput) return;
  const ready = Boolean(cleanPrompt(promptInput.value));
  promptSend.disabled = !ready;
  promptSend.style.opacity = ready ? '1' : '0.35';
  promptSend.style.cursor = ready ? 'pointer' : 'not-allowed';
}

function sendIconSvg() {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
}

function closeIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
}

function positionPrompt(box) {
  const width = Math.min(440, Math.max(280, window.innerWidth - 24));
  const height = 50;
  const left = clamp(box.x, 12, Math.max(12, window.innerWidth - width - 12));
  const below = box.y + box.height + 10;
  const above = box.y - height - 10;
  const top = below + height <= window.innerHeight - 12 ? below : above;
  promptBox.style.left = `${Math.round(left)}px`;
  promptBox.style.top = `${Math.round(clamp(top, 12, Math.max(12, window.innerHeight - height - 12)))}px`;
}

function sendDesignPrompt(payload) {
  ipcRenderer.send('native-browser-design-prompt', payload);
}
