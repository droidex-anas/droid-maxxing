/* global document, window, Element, Event, InputEvent, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, getComputedStyle */

import { cleanText, settle } from './dom.js';
import {
  currentAgentSnapshotTarget,
  inspectElement,
  pageSnapshot,
  requireCurrentAgentActionContext,
  requireCurrentAgentSnapshotTarget,
  requirePointOnExpectedTarget,
  requireSafeAgentTextAction,
  safeSnapshot,
} from './agentSnapshot.js';

export {
  beginAgentInputSuppression,
  endAgentInputSuppression,
  isAgentInputSuppressed,
  runAgentAction,
  resolveAgentPointer,
};

const RANGE_TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);
const VALUE_TEXT_INPUT_TYPES = new Set([
  'email',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

let agentInputSuppression = null;

function beginAgentInputSuppression(requestId) {
  const id = String(requestId || '');
  if (!id) throw new Error('Native browser click requires a request id.');
  agentInputSuppression = id;
}

function endAgentInputSuppression(requestId) {
  if (agentInputSuppression !== requestId) return false;
  agentInputSuppression = null;
  return true;
}

function isAgentInputSuppressed() {
  return agentInputSuppression !== null;
}

async function runAgentAction(request) {
  try {
    const action = request && request.action;
    const nativeInputPhase = action === 'click' ? request.nativeInputPhase : undefined;
    if (nativeInputPhase === 'cancel') {
      endAgentInputSuppression(request.requestId);
      return sendAgent({ requestId: request.requestId, ok: true });
    }
    if (nativeInputPhase === 'complete') {
      if (!endAgentInputSuppression(request.requestId)) {
        throw new Error('Native browser click input lease expired before completion.');
      }
      await settle();
      return sendAgent({ requestId: request.requestId, ok: true, snapshot: pageSnapshot() });
    }
    if (action !== 'snapshot') requireCurrentAgentActionContext(request.__droidexContext);
    let scrollAttempt;
    if (action === 'inspect') {
      return sendAgent({
        requestId: request.requestId,
        ok: true,
        inspection: inspectElement(request.selector, request.ref),
      });
    }
    if (action === 'click') {
      if (nativeInputPhase !== 'prepare') {
        throw new Error('Native browser click requires trusted input dispatch.');
      }
      const target =
        request.ref || request.selector
          ? requireCurrentAgentSnapshotTarget(request.ref, request.selector)
          : undefined;
      validateClickTargetAt(Number(request.x), Number(request.y), target);
      beginAgentInputSuppression(request.requestId);
      return sendAgent({ requestId: request.requestId, ok: true });
    } else if (action === 'hover') {
      const target =
        request.ref || request.selector
          ? requireCurrentAgentSnapshotTarget(request.ref, request.selector)
          : undefined;
      validateHoverTargetAt(Number(request.x), Number(request.y), target);
      return sendAgent({ requestId: request.requestId, ok: true });
    } else if (action === 'selectOption')
      selectOption(request.selector, request.text || '', request.ref);
    else if (action === 'type') {
      requireSafeAgentTextAction(request);
      typeIntoFocused(request.text || '');
    } else if (action === 'keypress') {
      requireSafeAgentTextAction(request);
      pressKey(request.key || '');
    } else if (action === 'scroll') scrollAttempt = scrollPage(request);
    else if (action !== 'snapshot') throw new Error(`Unsupported browser action: ${action}`);
    await settle();
    const snapshot = pageSnapshot();
    if (scrollAttempt) snapshot.scrollResult = finishScrollAttempt(scrollAttempt);
    return sendAgent({ requestId: request.requestId, ok: true, snapshot });
  } catch (err) {
    return sendAgent({
      requestId: request && request.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      snapshot: safeSnapshot(),
    });
  }
}

function validateClickTargetAt(x, y, expectedTarget) {
  const target = document.elementFromPoint(x, y);
  if (!target) throw new Error(`No element at ${x},${y}`);
  requirePointOnExpectedTarget(target, expectedTarget);
}

function validateHoverTargetAt(x, y, expectedTarget) {
  const target = document.elementFromPoint(x, y);
  if (!target) throw new Error(`No element at ${x},${y}`);
  requirePointOnExpectedTarget(target, expectedTarget);
}

function typeIntoFocused(text) {
  const active = document.activeElement;
  if (!active) throw new Error('No focused element for typing.');
  const value = String(text);
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const type = active instanceof HTMLInputElement ? inputType(active) : 'text';
    if (
      active.disabled ||
      active.readOnly ||
      (!RANGE_TEXT_INPUT_TYPES.has(type) && !VALUE_TEXT_INPUT_TYPES.has(type))
    ) {
      throw new Error('Focused element is not text-editable.');
    }
    const start = active.selectionStart == null ? active.value.length : active.selectionStart;
    const end = active.selectionEnd == null ? active.value.length : active.selectionEnd;
    // setRangeText throws on inputs whose type has no selection API (number,
    // email, date, ...), so splice those values directly instead.
    if (!RANGE_TEXT_INPUT_TYPES.has(type)) {
      const old = active.value;
      active.value = old.slice(0, start) + value + old.slice(end);
    } else {
      active.setRangeText(value, start, end, 'end');
    }
    active.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
    active.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (active.isContentEditable) {
    document.execCommand('insertText', false, value);
    active.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
    return;
  }
  throw new Error('Focused element is not text-editable.');
}

function inputType(el) {
  return el.type;
}

function selectOption(selector, value, ref) {
  if (!selector) throw new Error('Select option requires a target selector.');
  const target = requireCurrentAgentSnapshotTarget(ref, selector);
  if (!(target instanceof HTMLSelectElement)) {
    throw new Error('Target is not a select element.');
  }
  const expected = String(value);
  const option = Array.from(target.options).find(
    (item) =>
      item.value === expected ||
      cleanText(item.label) === expected ||
      cleanText(item.textContent) === expected,
  );
  if (!option) throw new Error(`Option "${expected}" is not available.`);
  target.value = option.value;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

// The key itself is dispatched natively by the main process; this only
// validates the request so the untrusted page never sees a synthetic event.
function pressKey(key) {
  if (!String(key)) throw new Error('Browser keypress requires a key.');
}

function scrollPage(request) {
  const direction = request.direction || 'down';
  const pixels = Math.max(1, Math.round(Number(request.pixels) || 500));
  const dx = direction === 'left' ? -pixels : direction === 'right' ? pixels : 0;
  const dy = direction === 'up' ? -pixels : direction === 'down' ? pixels : 0;
  const target = scrollTargetFor(request, dx !== 0);
  const before = { left: target.scrollLeft, top: target.scrollTop };
  target.scrollBy({ left: dx, top: dy, behavior: 'auto' });
  return { target, before, requested: { x: dx, y: dy } };
}

function finishScrollAttempt(attempt) {
  const x = Math.round(attempt.target.scrollLeft);
  const y = Math.round(attempt.target.scrollTop);
  const moved = x !== attempt.before.left || y !== attempt.before.top;
  return { x, y, moved, atBoundary: !moved, requested: attempt.requested };
}

function scrollTargetFor(request, horizontal) {
  let target = request.selector
    ? requireCurrentAgentSnapshotTarget(request.ref, request.selector)
    : currentAgentSnapshotTarget(request.ref, request.selector) ||
      document.elementFromPoint(Number(request.x), Number(request.y));
  while (target instanceof Element) {
    const style = getComputedStyle(target);
    const overflow = horizontal ? style.overflowX : style.overflowY;
    const canMove = horizontal
      ? target.scrollWidth > target.clientWidth
      : target.scrollHeight > target.clientHeight;
    if (canMove && /(auto|scroll|overlay)/.test(overflow)) return target;
    target = target.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function sendAgent(payload) {
  return payload;
}

function resolveAgentPointer(request) {
  try {
    let point;
    const target = currentAgentSnapshotTarget(request?.ref, request?.selector);
    if (target) {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      const box = target.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return null;
      point = {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
      };
    } else if (request?.ref || request?.selector) {
      return null;
    } else {
      point = { x: Math.round(Number(request?.x)), y: Math.round(Number(request?.y)) };
    }
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= window.innerWidth ||
      point.y >= window.innerHeight
    ) {
      return null;
    }
    return point;
  } catch {
    return null;
  }
}
