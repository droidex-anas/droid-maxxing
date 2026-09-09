/* global document, window, Event */

import { ipcRenderer } from 'electron';
import { INTERNAL_ATTR, firstVisible, isVisible } from './dom.js';
import { isSensitiveField, savedCredentialFields } from './elementInspection.js';

export { onFormSubmit, fillCredentials, maskSensitiveFields };

// Observe (never block) login submissions so the main process can offer to
// save the credential. The values flow straight to main over IPC and are
// encrypted there; nothing is stored in the page or exposed to the agent.
function onFormSubmit(event) {
  try {
    const form = event.target;
    if (!form || form.getAttribute(INTERNAL_ATTR)) return;
    const fields = form.querySelectorAll ? form.querySelectorAll('input') : [];
    let username = null;
    const currentPasswords = [];
    const newPasswords = [];
    const unspecifiedPasswords = [];
    for (const field of fields) {
      const type = (field.getAttribute('type') || '').toLowerCase();
      const autocomplete = (field.getAttribute('autocomplete') || '').toLowerCase();
      if (type === 'password' && field.value) {
        if (autocomplete.includes('current-password')) currentPasswords.push(field.value);
        else if (autocomplete.includes('new-password')) newPasswords.push(field.value);
        else unspecifiedPasswords.push(field.value);
      } else if (
        !username &&
        (type === 'email' || type === 'text' || type === '' || type === 'tel') &&
        field.value
      )
        username = field.value;
    }
    let password;
    let kind;
    if (currentPasswords.length === 1 && newPasswords.length === 0) {
      password = currentPasswords[0];
      kind = 'current_password';
    } else if (currentPasswords.length === 0 && new Set(newPasswords).size === 1) {
      password = newPasswords[0];
      kind = 'new_password';
    } else if (
      currentPasswords.length === 0 &&
      newPasswords.length === 0 &&
      unspecifiedPasswords.length === 1
    ) {
      password = unspecifiedPasswords[0];
      kind = 'current_password';
    }
    if (!password) return;
    ipcRenderer.send('native-browser-credential-capture', {
      username: username || '',
      password,
      kind,
    });
  } catch {
    // Never interfere with the page's own submit.
    return;
  }
}

function fillCredentials(payload) {
  try {
    const username = payload && typeof payload.username === 'string' ? payload.username : '';
    const password = payload && typeof payload.password === 'string' ? payload.password : '';
    if (!password) return { ok: false, filled: false };
    const passwordFields = [...document.querySelectorAll('input[type="password"]')].filter(
      (field) =>
        isVisible(field) &&
        !(field.getAttribute('autocomplete') || '').toLowerCase().includes('new-password'),
    );
    if (passwordFields.length !== 1) {
      return { ok: false, filled: false, error: 'No unambiguous current-password form found.' };
    }
    const passwordField = passwordFields[0];
    if (username) {
      const userField = usernameFieldFor(passwordField);
      if (userField) {
        savedCredentialFields.add(userField);
        setFieldValue(userField, username);
      }
    }
    savedCredentialFields.add(passwordField);
    setFieldValue(passwordField, password);
    return { ok: true, filled: true };
  } catch (err) {
    return { ok: false, filled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

let maskedSensitiveFields = [];

function maskSensitiveFields(active) {
  if (!active) {
    for (const { field, style } of maskedSensitiveFields) {
      if (field.isConnected) {
        if (style === null) field.removeAttribute('style');
        else field.setAttribute('style', style);
      }
    }
    maskedSensitiveFields = [];
    return true;
  }
  if (maskedSensitiveFields.length > 0) return true;
  for (const field of document.querySelectorAll('input, textarea')) {
    if (!isSensitiveField(field)) continue;
    maskedSensitiveFields.push({ field, style: field.getAttribute('style') });
    field.style.setProperty('color', 'transparent', 'important');
    field.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
    field.style.setProperty('text-shadow', 'none', 'important');
    field.style.setProperty('caret-color', 'transparent', 'important');
    field.style.setProperty('background-image', 'none', 'important');
  }
  return true;
}

function usernameFieldFor(passwordField) {
  const form = passwordField.form;
  const scope = form || document;
  const fields = scope.querySelectorAll('input');
  let previous = null;
  for (const field of fields) {
    if (field === passwordField) break;
    const type = (field.getAttribute('type') || '').toLowerCase();
    if ((type === 'email' || type === 'text' || type === 'tel' || type === '') && isVisible(field))
      previous = field;
  }
  return (
    previous ||
    firstVisible(
      scope.querySelectorAll(
        'input[type="email"],input[type="text"],input[type="tel"],input:not([type])',
      ),
    )
  );
}

function setFieldValue(field, value) {
  field.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}
