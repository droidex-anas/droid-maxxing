/* global crypto, document, window, location, Element, NodeFilter, HTMLIFrameElement */

import { agentVisibleUrl, sanitizeUrl } from './diagnostics.js';
import {
  INTERNAL_ATTR,
  boxFor,
  cleanText,
  directText,
  isVisible,
  roleFor,
  safeElementText,
  stableHash,
} from './dom.js';
import { attrsFor, canAccessFrame, sanitizedOuterHtml, selectorFor } from './elementInspection.js';
import { sensitiveFocusedField } from './sensitiveFields.js';

export {
  agentSnapshotTargets,
  safeSnapshot,
  pageSnapshot,
  collectRefs,
  isCandidate,
  browserAgentActionContext,
  requireCurrentAgentActionContext,
  requireSafeAgentTextAction,
  currentAgentSnapshotTarget,
  requireCurrentAgentSnapshotTarget,
  requirePointOnExpectedTarget,
  invalidateAgentSnapshot,
  inspectElement,
};

const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY']);

const interactiveRoles = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'switch',
  'tab',
  'textbox',
]);

const textTags = new Set([
  'BLOCKQUOTE',
  'CODE',
  'EM',
  'FIGCAPTION',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LABEL',
  'LI',
  'P',
  'PRE',
  'SMALL',
  'SPAN',
  'STRONG',
  'TD',
  'TH',
]);

const mediaTags = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME']);

const MAX_SNAPSHOT_VISITED_NODES = 2_000;

const agentDocumentId = crypto.randomUUID();
let agentSnapshotSequence = 0;
let agentSnapshotId = '';
const agentSnapshotTargets = new Map();

function safeSnapshot() {
  try {
    return pageSnapshot();
  } catch {
    return { url: agentVisibleUrl(), title: document.title, scroll: { x: 0, y: 0 }, refs: [] };
  }
}

function pageSnapshot() {
  agentSnapshotId = `${agentDocumentId}:${String(++agentSnapshotSequence)}`;
  agentSnapshotTargets.clear();
  return {
    url: agentVisibleUrl(),
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    refs: collectRefs(),
  };
}

function collectRefs() {
  const visible = [];
  const offscreen = [];
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = root;
  let visitedNodes = 0;
  while (node && visible.length < 80 && visitedNodes < MAX_SNAPSHOT_VISITED_NODES) {
    visitedNodes += 1;
    if (isCandidate(node)) {
      const bucket = intersectsViewport(node.getBoundingClientRect()) ? visible : offscreen;
      if (bucket.length < 80) bucket.push(refFor(node));
    }
    node = walker.nextNode();
  }
  return [...visible, ...offscreen].slice(0, 80);
}

function intersectsViewport(rect) {
  return (
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

function refFor(el) {
  const rect = el.getBoundingClientRect();
  const text = safeElementText(el);
  const selector = selectorFor(el);
  const name = cleanText(
    el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      directText(el) ||
      text,
  );
  const ref = browserRefForSelector(selector);
  agentSnapshotTargets.set(ref, { element: el, selector });
  return {
    ref,
    selector,
    tagName: el.tagName.toLowerCase(),
    role: roleFor(el) || undefined,
    name: name || undefined,
    text: text || undefined,
    attributes: attrsFor(el),
    box: boxFor(rect),
  };
}

function browserRefForSelector(selector) {
  return `@b-${agentSnapshotId}-${stableHash(selector)}`;
}

function isCandidate(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (el.closest(`[${INTERNAL_ATTR}]`) || !isVisible(el)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const area = rect.width * rect.height;
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  if (area > viewportArea * 0.72) return false;
  const role = roleFor(el).toLowerCase();
  if (
    interactiveTags.has(el.tagName) ||
    interactiveRoles.has(role) ||
    el.onclick ||
    el.tabIndex >= 0
  )
    return true;
  if (textTags.has(el.tagName) && safeElementText(el)) return true;
  if (mediaTags.has(el.tagName)) return true;
  if (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid'))
    return true;
  return Boolean(directText(el)) && area < viewportArea * 0.35;
}

function browserAgentActionContext() {
  return {
    documentId: agentDocumentId,
    snapshotId: agentSnapshotId,
    urlHash: stableHash(location.href),
  };
}

function requireCurrentAgentActionContext(expected) {
  const current = browserAgentActionContext();
  if (
    !expected ||
    expected.documentId !== current.documentId ||
    expected.snapshotId !== current.snapshotId ||
    expected.urlHash !== current.urlHash
  ) {
    throw new Error('The page changed before the browser action completed. No input was sent.');
  }
}

function requireSafeAgentTextAction(request) {
  const needsCheck =
    request.action === 'type' ||
    (request.action === 'keypress' && !['Enter', 'Tab', 'Escape'].includes(request.key));
  if (!needsCheck) return;
  const sensitive = sensitiveFocusedField();
  if (sensitive?.kind) {
    throw new Error(
      `DROIDEX will not send agent-authored text into a ${sensitive.kind} field. Use a saved login, OAuth/passkey, or enter it yourself.`,
    );
  }
}

function currentAgentSnapshotTarget(ref, selector) {
  if (!agentSnapshotId || !ref) return null;
  const target = agentSnapshotTargets.get(ref);
  if (
    !target ||
    (selector && target.selector !== selector) ||
    !(target.element instanceof Element) ||
    !target.element.isConnected ||
    target.element.ownerDocument !== document
  ) {
    return null;
  }
  return target.element;
}

function requireCurrentAgentSnapshotTarget(ref, selector) {
  const target = currentAgentSnapshotTarget(ref, selector);
  if (!target) throw new Error('Browser target belongs to an expired page snapshot.');
  return target;
}

function requirePointOnExpectedTarget(actualTarget, expectedTarget) {
  if (expectedTarget && actualTarget !== expectedTarget && !expectedTarget.contains(actualTarget)) {
    throw new Error('Browser target moved before the action completed. Refresh the snapshot.');
  }
}

function invalidateAgentSnapshot() {
  agentSnapshotId = '';
  agentSnapshotTargets.clear();
}

function inspectElement(selector, ref) {
  if (!selector) throw new Error('Element inspection requires a selector.');
  const el = ref
    ? requireCurrentAgentSnapshotTarget(ref, selector)
    : document.querySelector(selector);
  if (!el) throw new Error('The inspected browser element is no longer available.');
  const rect = el.getBoundingClientRect();
  const text = safeElementText(el, 1000);
  const name = cleanText(
    el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      directText(el) ||
      text,
    240,
  );
  const iframe =
    el instanceof HTMLIFrameElement
      ? {
          src: sanitizeUrl(el.src || el.getAttribute('src') || ''),
          accessible: canAccessFrame(el),
        }
      : undefined;
  return {
    selector,
    tagName: el.tagName.toLowerCase(),
    role: roleFor(el) || undefined,
    name: name || undefined,
    text: text || undefined,
    attributes: attrsFor(el),
    box: boxFor(rect),
    html: sanitizedOuterHtml(el),
    iframe,
  };
}
