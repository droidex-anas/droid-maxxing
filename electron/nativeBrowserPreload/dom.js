/* global document, window, CSS, Node, requestAnimationFrame */

export {
  INTERNAL_ATTR,
  redactedTextTags,
  element,
  swallow,
  isInternalEvent,
  firstVisible,
  isVisible,
  settle,
  point,
  boxFor,
  clamp,
  roleFor,
  directText,
  safeElementText,
  cleanText,
  cleanPrompt,
  cssEscape,
  stableHash,
};

const INTERNAL_ATTR = 'data-droid-design';

const redactedTextTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

function element(tag, styles) {
  const node = document.createElement(tag);
  node.style.cssText = styles.join(';');
  return node;
}

function swallow(event) {
  event.preventDefault();
  event.stopPropagation();
}

function isInternalEvent(event) {
  return Boolean(
    event.target && event.target.closest && event.target.closest(`[${INTERNAL_ATTR}]`),
  );
}

function firstVisible(nodes) {
  for (const node of nodes) if (isVisible(node)) return node;
  return null;
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function settle() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function point(event) {
  return { x: event.clientX, y: event.clientY };
}

function boxFor(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roleFor(el) {
  return (
    el.getAttribute('role') ||
    { A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[
      el.tagName
    ] ||
    ''
  );
}

function directText(el) {
  if (redactedTextTags.has(el.tagName)) return '[redacted]';
  return cleanText(
    Array.from(el.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || '')
      .join(' '),
  );
}

function safeElementText(el, max = 180) {
  if (redactedTextTags.has(el.tagName)) return '[redacted]';
  if (!el.querySelector('script,style,noscript')) {
    return cleanText(el.innerText || el.textContent, max);
  }
  const clone = el.cloneNode(true);
  for (const node of clone.querySelectorAll('script,style,noscript')) node.remove();
  return cleanText(clone.textContent, max);
}

function cleanText(value, max = 180) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanPrompt(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

function stableHash(value) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}
