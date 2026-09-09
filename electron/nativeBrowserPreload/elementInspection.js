/* global document, getComputedStyle, HTMLElement, HTMLInputElement, HTMLTextAreaElement, Node */

import { sanitizeUrl, isSensitiveBrowserKey } from './diagnostics.js';
import { cssEscape, redactedTextTags } from './dom.js';

export {
  savedCredentialFields,
  selectorFor,
  verifySelector,
  attrsFor,
  isSensitiveAttribute,
  isMetaRefreshContent,
  isSensitiveField,
  sensitiveFocusedField,
  stylesFor,
  ancestorsFor,
  canAccessFrame,
  sanitizedOuterHtml,
};

const urlAttributes = new Set([
  'action',
  'archive',
  'background',
  'cite',
  'codebase',
  'data',
  'formaction',
  'href',
  'itemid',
  'manifest',
  'poster',
  'profile',
  'src',
  'usemap',
  'xlink:href',
]);

const redactedUrlAttributes = new Set(['ping', 'srcdoc', 'srcset', 'style']);

const savedCredentialFields = new WeakSet();

function selectorFor(el) {
  if (el.id) {
    const selector = `#${cssEscape(el.id)}`;
    if (verifySelector(el, selector)) return selector;
  }
  const testId = el.getAttribute('data-testid');
  if (testId) {
    const selector = `[data-testid="${cssEscape(testId)}"]`;
    if (verifySelector(el, selector)) return selector;
  }
  const aria = el.getAttribute('aria-label');
  if (aria) {
    const selector = `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
    if (verifySelector(el, selector)) return selector;
  }
  const parts = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    const selector = parts.join(' > ');
    if (verifySelector(el, selector)) return selector;
    node = parent;
  }
  return parts.join(' > ');
}

function verifySelector(el, selector) {
  if (!selector) return false;
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch {
    return false;
  }
}

function attrsFor(el) {
  const out = {};
  const secret = isSensitiveField(el);
  for (const name of [
    'id',
    'class',
    'data-testid',
    'aria-label',
    'title',
    'placeholder',
    'type',
    'href',
    'src',
    'action',
    'name',
    'value',
    'role',
  ]) {
    const value = el.getAttribute && el.getAttribute(name);
    if (!value) continue;
    if (isSensitiveAttribute(name, el) || (name === 'value' && secret)) {
      out[name] = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      continue;
    }
    out[name] = urlAttributes.has(name)
      ? sanitizeUrl(value).slice(0, 500)
      : String(value).slice(0, 160);
  }
  return out;
}

function isSensitiveAttribute(name, el) {
  if (name === 'nonce') return true;
  if (name === 'value' || name.startsWith('on')) return true;
  if (
    /(token|secret|password|passcode|credential|authorization|api[-_]?key|private[-_]?key|cookie|session|csrf|otp)/i.test(
      name,
    )
  )
    return true;
  if (name !== 'content') return false;
  const fieldName = String(el.getAttribute && el.getAttribute('name')).toLowerCase();
  return isSensitiveBrowserKey(fieldName);
}

function isMetaRefreshContent(name, el) {
  return (
    name === 'content' &&
    el.tagName === 'META' &&
    String(el.getAttribute('http-equiv') || '').toLowerCase() === 'refresh'
  );
}

// Password and one-time-code fields must never reach the agent transcript, so
// their live values are redacted from every snapshot/detail payload.
function isSensitiveField(el) {
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return false;
  if (savedCredentialFields.has(el)) return true;
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return true;
  const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
  return (
    auto.includes('password') ||
    auto.split(/\s+/).includes('one-time-code') ||
    /otp|verification|passcode/i.test(el.name || el.id)
  );
}

function sensitiveFocusedField() {
  const field = document.activeElement;
  const editable =
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement ||
    (field instanceof HTMLElement && field.isContentEditable);
  if (!editable) return null;
  const type = (field.getAttribute('type') || '').toLowerCase();
  const autocomplete = (field.getAttribute('autocomplete') || '').toLowerCase();
  if (type === 'password' || autocomplete.includes('password')) return { kind: 'password' };
  if (
    autocomplete.includes('one-time-code') ||
    /otp|verification|passcode/i.test(field.name || field.id)
  ) {
    return { kind: 'one-time code' };
  }
  return null;
}

function stylesFor(el) {
  const style = getComputedStyle(el);
  return {
    color: style.color,
    backgroundColor: style.backgroundColor,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    display: style.display,
    padding: style.padding,
    margin: style.margin,
    border: style.border,
  };
}

function ancestorsFor(el) {
  const out = [];
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement && out.length < 4) {
    const testId = node.getAttribute('data-testid');
    out.push({
      tag: node.tagName.toLowerCase(),
      selector: node.id
        ? `#${cssEscape(node.id)}`
        : testId
          ? `[data-testid="${cssEscape(testId)}"]`
          : undefined,
    });
    node = node.parentElement;
  }
  return out;
}

function canAccessFrame(frame) {
  try {
    return Boolean(frame.contentDocument);
  } catch {
    return false;
  }
}

function sanitizedOuterHtml(el) {
  const clone = el.cloneNode(true);
  if (redactedTextTags.has(clone.tagName)) {
    clone.textContent = '[redacted]';
  } else {
    for (const node of clone.querySelectorAll('script,style,noscript')) node.remove();
  }
  const nodes = [clone, ...clone.querySelectorAll('*')];
  for (const node of nodes) {
    for (const attr of Array.from(node.attributes || [])) {
      const name = attr.name.toLowerCase();
      if (isSensitiveAttribute(name, node)) {
        node.setAttribute(attr.name, '[redacted]');
      } else if (redactedUrlAttributes.has(name) || isMetaRefreshContent(name, node)) {
        node.setAttribute(attr.name, '[redacted]');
      } else if (urlAttributes.has(name)) {
        node.setAttribute(attr.name, sanitizeUrl(attr.value));
      }
    }
  }
  return String(clone.outerHTML || '').slice(0, 4000);
}
