/* global document */

export const editableFieldSelector = 'input,textarea,[contenteditable]';
export const savedCredentialFields = new WeakSet();

function sensitiveFieldKind(el) {
  for (let field = el; field; field = field.parentElement) {
    if (savedCredentialFields.has(field)) return 'saved login';
    if (field.tagName !== 'INPUT' && field.tagName !== 'TEXTAREA' && !field.isContentEditable) {
      continue;
    }
    const type = (field.getAttribute('type') || '').toLowerCase();
    const autocomplete = (field.getAttribute('autocomplete') || '').toLowerCase();
    if (type === 'password' || autocomplete.includes('password')) return 'password';
    if (
      autocomplete.split(/\s+/).includes('one-time-code') ||
      /otp|verification|passcode/i.test(`${field.getAttribute('name') || ''} ${field.id}`)
    ) {
      return 'one-time code';
    }
  }
  return null;
}

export function isSensitiveField(el) {
  return sensitiveFieldKind(el) !== null;
}

export function sensitiveFocusedField() {
  let active = document.activeElement;
  while (active?.tagName === 'IFRAME' || active?.tagName === 'FRAME') {
    // Native key events reach child frames even when their DOM is inaccessible.
    const frameDocument = active.contentDocument;
    if (!frameDocument?.activeElement) return { kind: 'protected frame' };
    active = frameDocument.activeElement;
  }
  const kind = sensitiveFieldKind(active);
  return kind ? { kind } : null;
}
