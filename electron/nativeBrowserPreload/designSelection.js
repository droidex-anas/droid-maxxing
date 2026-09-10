/* global document, window, Node */

import { agentVisibleUrl } from './diagnostics.js';
import {
  boxFor,
  cleanText,
  directText,
  INTERNAL_ATTR,
  roleFor,
  safeElementText,
  stableHash,
} from './dom.js';
import {
  ancestorsFor,
  attrsFor,
  sanitizedOuterHtml,
  selectorFor,
  stylesFor,
  verifySelector,
} from './elementInspection.js';
import { resolveSource } from './elementSource.js';
import { state } from './designState.js';
import { strokesBounds } from './designAnnotations.js';
import { editableFieldSelector } from './sensitiveFields.js';

export { elementSelection, sketchSelection, textSelection, pickTarget, labelFor };

function elementSelection(el) {
  const selector = selectorFor(el);
  const verified = verifySelector(el, selector);
  const source = resolveSource(el);
  const anchor = buildAnchor(el, selector, source);
  const detail = buildDetail(el, selector, verified);
  return {
    anchor,
    detail,
    url: agentVisibleUrl(),
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
  };
}

function sketchSelection() {
  const box = strokesBounds();
  if (!box) return null;
  return {
    anchor: {
      id: `@sketch-${Date.now().toString(36)}`,
      kind: 'region',
      label: `sketch (${state.strokes.length} stroke${state.strokes.length === 1 ? '' : 's'})`,
      box,
      strokes: state.strokes.map((stroke) =>
        stroke.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) })),
      ),
    },
    url: agentVisibleUrl(),
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
  };
}

function textSelection() {
  if (!state.textRange || state.textRange.collapsed) return null;
  for (const field of document.querySelectorAll(editableFieldSelector)) {
    if (state.textRange.intersectsNode(field)) return null;
  }
  const text = cleanText(state.textRange.toString(), 400);
  if (!text) return null;
  const rect = state.textRange.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const container = state.textRange.commonAncestorContainer;
  const el = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
  const selector = el ? selectorFor(el) : '';
  const source = el ? resolveSource(el) : undefined;
  return {
    anchor: {
      id: `@text-${stableHash(`${selector}:${text}`)}`,
      kind: 'text',
      label: `text "${cleanText(text, 40)}"`,
      tag: el ? el.tagName.toLowerCase() : undefined,
      text,
      box: boxFor(rect),
      source,
    },
    detail: el
      ? {
          id: `@text-${stableHash(`${selector}:${text}`)}`,
          selector,
          selectorVerified: verifySelector(el, selector),
          attributes: attrsFor(el),
          styles: stylesFor(el),
          ancestors: ancestorsFor(el),
          html: cleanText(sanitizedOuterHtml(el), 400) || undefined,
        }
      : undefined,
    url: agentVisibleUrl(),
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
  };
}

function buildAnchor(el, selector, source) {
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const text = safeElementText(el, 80);
  const name = cleanText(
    el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      directText(el) ||
      text,
    80,
  );
  return {
    id: `@live-${stableHash(selector)}`,
    kind: 'element',
    label: labelText(tag, source, name || text),
    tag,
    role: roleFor(el) || undefined,
    name: name || undefined,
    text: text || undefined,
    box: boxFor(rect),
    source,
  };
}

function buildDetail(el, selector, verified) {
  return {
    id: `@live-${stableHash(selector)}`,
    selector,
    selectorVerified: verified,
    attributes: attrsFor(el),
    styles: stylesFor(el),
    ancestors: ancestorsFor(el),
    html: cleanText(sanitizedOuterHtml(el), 400) || undefined,
  };
}

function labelText(tag, source, text) {
  const component = source && source.component ? `${source.component} \u203a ` : '';
  const quoted = text ? ` "${cleanText(text, 40)}"` : '';
  return `${component}<${tag}>${quoted}`;
}

function pickTarget(x, y, climb) {
  let node = document.elementFromPoint(x, y);
  while (node && node.getAttribute && node.getAttribute(INTERNAL_ATTR)) node = node.parentElement;
  if (!node || node === document.documentElement) return null;
  if (climb) {
    const parent = node.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) return parent;
  }
  return node;
}

function labelFor(el) {
  const tag = el.tagName.toLowerCase();
  const source = resolveSource(el);
  const text = cleanText(
    el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      directText(el) ||
      el.id ||
      safeElementText(el) ||
      '',
    40,
  );
  const head = labelText(tag, source, text);
  if (source && source.file) {
    return `${head}  ${source.file}${source.line ? `:${source.line}` : ''}`;
  }
  return `${head}${state.altHeld ? '' : '  (alt: parent, shift-drag: text)'}`;
}
