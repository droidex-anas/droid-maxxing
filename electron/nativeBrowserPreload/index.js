/* global document, window, requestAnimationFrame, clearTimeout */

import { contextBridge, ipcRenderer } from 'electron';
import { isInternalEvent, point, swallow } from './dom.js';
import { sensitiveFocusedField } from './elementInspection.js';
import { browserAgentActionContext, invalidateAgentSnapshot } from './agentSnapshot.js';
import { resolveAgentPointer, runAgentAction } from './agentActions.js';
import { inspectAuthenticationIntent } from './authIntent.js';
import { fillCredentials, maskSensitiveFields, onFormSubmit } from './credentialFill.js';
import {
  rememberTrustedPhysicalFormActivation,
  reportTrustedUserNavigation,
} from './trustedNavigation.js';
import { hideBox, mount, overlay, penSvg, positionBox, showBox, state } from './designState.js';
import {
  addAnnotation,
  appendStrokePath,
  clearAnnotations,
  clearTextHighlights,
  extendActiveStroke,
  queueReposition,
  repositionAnnotations,
  strokeLength,
  updateTextRange,
} from './designAnnotations.js';
import {
  elementSelection,
  labelFor,
  pickTarget,
  sketchSelection,
  textSelection,
} from './designSelection.js';
import {
  cancelDesign,
  finishCapture,
  hidePrompt,
  promptVisible,
  showPrompt,
} from './designPrompt.js';

function applyState(next) {
  state.designMode = Boolean(next && next.designMode);
  state.pencilMode = state.designMode && Boolean(next && next.pencilMode);
  state.hoverTarget = null;
  state.activeStroke = null;
  state.textDragStart = null;
  if (!state.designMode) {
    state.capturePending = false;
    state.pendingCaptureId = null;
    if (state.clearTimer) {
      clearTimeout(state.clearTimer);
      state.clearTimer = null;
    }
    hideBox();
    hidePrompt();
    clearAnnotations();
    return;
  }
  mount();
  hideBox();
  repositionAnnotations();
}

function onWheel(event) {
  if (!state.designMode || !state.capturePending) return;
  swallow(event);
}

function onKey(event) {
  if (!state.designMode) return;
  // Freeze keyboard scrolling (space, arrows, page keys) during capture so the
  // viewport cannot shift out from under the region being captured.
  if (state.capturePending) {
    if (event.type === 'keydown') swallow(event);
    return;
  }
  state.altHeld = Boolean(event.altKey);
  if (event.type === 'keydown' && event.key === 'Escape') {
    // Escape must cancel reliably even when focus is not inside the composer
    // (the composer's own handler only fires when it holds focus).
    if (promptVisible()) cancelDesign();
    else clearAnnotations();
  }
}

function onMouseMove(event) {
  if (!state.designMode) return;
  if (isInternalEvent(event)) return;
  if (state.capturePending) {
    swallow(event);
    return;
  }
  state.altHeld = Boolean(event.altKey);
  if (state.activeStroke) {
    state.activeStroke.push(point(event));
    extendActiveStroke();
    swallow(event);
    return;
  }
  if (state.textDragStart) {
    updateTextRange(state.textDragStart, point(event));
    swallow(event);
    return;
  }
  // While the prompt composer is open the selection is locked in, so the
  // cursor can travel to the prompt without re-triggering hover/marker.
  if (state.pencilMode || promptVisible()) return;
  state.pendingHover = { x: event.clientX, y: event.clientY, alt: state.altHeld };
  if (state.hoverFrame) return;
  state.hoverFrame = requestAnimationFrame(processHover);
}

function processHover() {
  state.hoverFrame = 0;
  if (
    !state.designMode ||
    !state.pendingHover ||
    state.pencilMode ||
    state.activeStroke ||
    state.textDragStart ||
    promptVisible()
  )
    return;
  const { x, y, alt } = state.pendingHover;
  const target = pickTarget(x, y, alt);
  if (!target) {
    state.hoverTarget = null;
    hideBox();
    return;
  }
  if (target === state.hoverTarget) {
    overlay.style.display = 'block';
    positionBox(overlay, target.getBoundingClientRect());
    return;
  }
  state.hoverTarget = target;
  showBox(target.getBoundingClientRect(), labelFor(target));
}

function onMouseDown(event) {
  if (!state.designMode || event.button !== 0) return;
  if (isInternalEvent(event)) return;
  if (state.capturePending) {
    swallow(event);
    return;
  }
  // Swallow so the underlying page cannot react to the press while the
  // composer is open; clicks elsewhere are also intercepted in onClick.
  if (promptVisible()) {
    swallow(event);
    return;
  }
  if (state.pencilMode) {
    state.activeStroke = [point(event)];
    state.strokes.push(state.activeStroke);
    state.activePath = appendStrokePath(state.activeStroke);
    hideBox();
    swallow(event);
    return;
  }
  if (event.shiftKey) {
    state.textDragStart = point(event);
    hideBox();
    swallow(event);
  }
}

function onMouseUp(event) {
  if (!state.designMode) return;
  if (state.capturePending) {
    swallow(event);
    return;
  }
  if (state.activeStroke) {
    const finished = state.strokes[state.strokes.length - 1];
    state.activeStroke = null;
    state.activePath = null;
    if (strokeLength(finished) < 6) {
      state.strokes.pop();
      const stalePath = state.strokePaths.pop();
      if (stalePath) stalePath.remove();
      if (state.strokes.length === 0) penSvg.style.display = 'none';
    } else {
      const selection = sketchSelection();
      if (selection) {
        sendSelection(selection);
        showPrompt(selection);
      }
    }
    swallow(event);
    return;
  }
  if (state.textDragStart) {
    const start = state.textDragStart;
    state.textDragStart = null;
    updateTextRange(start, point(event));
    const selection = textSelection();
    if (selection) {
      sendSelection(selection);
      showPrompt(selection);
    } else {
      clearTextHighlights();
    }
    swallow(event);
  }
}

function onContextMenu(event) {
  if (!state.designMode) return;
  swallow(event);
}

function onClick(event) {
  if (!state.designMode || state.pencilMode || event.shiftKey) return;
  if (isInternalEvent(event)) return;
  if (state.capturePending) {
    swallow(event);
    return;
  }
  if (promptVisible()) {
    swallow(event);
    return;
  }
  const target = pickTarget(event.clientX, event.clientY, Boolean(event.altKey));
  if (!target) return;
  const selection = elementSelection(target);
  addAnnotation(selection.anchor, target);
  sendSelection(selection);
  showPrompt(selection);
  swallow(event);
}

function sendSelection(payload) {
  ipcRenderer.send('native-browser-selection', payload);
}

contextBridge.exposeInMainWorld('__DROIDMAXX_APPLY_DESIGN_STATE', applyState);
contextBridge.exposeInMainWorld('__DROIDMAXX_AGENT_ACTION', runAgentAction);
contextBridge.exposeInMainWorld('__DROIDMAXX_AGENT_CONTEXT', browserAgentActionContext);
contextBridge.exposeInMainWorld('__DROIDMAXX_RESOLVE_POINTER', resolveAgentPointer);
// Credential autofill is driven entirely from the main process: the secret
// arrives here only to be written into the page's inputs and is never returned
// to any caller, so the agent can authorize a login without reading it.
contextBridge.exposeInMainWorld('__DROIDMAXX_FILL_CREDENTIALS', fillCredentials);
contextBridge.exposeInMainWorld('__DROIDMAXX_AUTH_INTENT', inspectAuthenticationIntent);
contextBridge.exposeInMainWorld('__DROIDMAXX_SENSITIVE_FIELD', sensitiveFocusedField);
contextBridge.exposeInMainWorld('__DROIDMAXX_MASK_SENSITIVE_FIELDS', maskSensitiveFields);

ipcRenderer.on('native-browser-design-prompt-sent', (_event, payload) => {
  // Ignore acks that do not match the capture currently in flight: a stale ack
  // from a superseded prompt must not clear a newer pending capture.
  if (state.pendingCaptureId === null || !payload || payload.captureId !== state.pendingCaptureId)
    return;
  finishCapture();
});
ipcRenderer.on('native-browser-agent-snapshot-invalidated', () => {
  invalidateAgentSnapshot();
});

document.addEventListener('submit', onFormSubmit, true);
document.addEventListener('submit', reportTrustedUserNavigation, false);
document.addEventListener('mousemove', onMouseMove, true);
document.addEventListener('pointerdown', rememberTrustedPhysicalFormActivation, true);
document.addEventListener('mousedown', onMouseDown, true);
document.addEventListener('mouseup', onMouseUp, true);
document.addEventListener('click', onClick, true);
document.addEventListener('click', reportTrustedUserNavigation, false);
document.addEventListener('contextmenu', onContextMenu, true);
document.addEventListener('keydown', onKey, true);
document.addEventListener('keydown', rememberTrustedPhysicalFormActivation, true);
document.addEventListener('keyup', onKey, true);
window.addEventListener('scroll', queueReposition, true);
window.addEventListener('resize', queueReposition, true);
// passive:false so we can cancel wheel scrolling while a capture is pending.
window.addEventListener('wheel', onWheel, { capture: true, passive: false });
window.addEventListener('touchmove', onWheel, { capture: true, passive: false });
