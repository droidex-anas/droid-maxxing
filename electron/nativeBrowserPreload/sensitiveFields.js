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
  const kind = sensitiveFieldKind(document.activeElement);
  return kind ? { kind } : null;
}
