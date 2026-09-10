/* global crypto, location, FormData, URL, URLSearchParams */

import { ipcRenderer } from 'electron';
import { isAgentInputSuppressed } from './agentActions.js';
import { state } from './designState.js';

export { rememberTrustedPhysicalFormActivation, reportTrustedUserNavigation };

let trustedPhysicalFormActivation = null;

function rememberTrustedPhysicalFormActivation(event) {
  if (!event.isTrusted || isAgentInputSuppressed()) return;
  if (event.type === 'pointerdown' && event.button !== 0) return;
  if (event.type === 'keydown' && event.key !== 'Enter') return;
  const form = event.target?.form || event.target?.closest?.('form');
  trustedPhysicalFormActivation = form ? { form, expiresAt: Date.now() + 1_000 } : null;
}

function consumeTrustedPhysicalFormActivation(form) {
  const activation = trustedPhysicalFormActivation;
  trustedPhysicalFormActivation = null;
  return Boolean(activation && activation.form === form && activation.expiresAt >= Date.now());
}

function reportTrustedUserNavigation(event) {
  if (!event.isTrusted || isAgentInputSuppressed() || state.designMode || state.capturePending)
    return;
  if (event.type === 'submit' && !consumeTrustedPhysicalFormActivation(event.target)) return;
  const destinationUrl = trustedUserNavigationDestination(event);
  if (!destinationUrl) return;
  const activationId = crypto.randomUUID();
  ipcRenderer.send('native-browser-user-navigation', { activationId, destinationUrl });
}

function trustedUserNavigationDestination(event) {
  if (event.defaultPrevented) return null;
  try {
    let value;
    if (event.type === 'click') {
      if (event.button !== 0) return null;
      const anchor = event.target?.closest?.('a[href],area[href]');
      if (!anchor || anchor.hasAttribute('download')) return null;
      value = anchor.href;
    } else if (event.type === 'submit') {
      const form = event.target;
      if (!form || form.tagName !== 'FORM') return null;
      const submitter = event.submitter;
      const method = String(submitter?.formMethod || form.method || 'get').toLowerCase();
      if (method === 'dialog') return null;
      value = submitter?.formAction || form.action;
      const url = new URL(value, location.href);
      if (method === 'get') {
        const data = submitter ? new FormData(form, submitter) : new FormData(form);
        const params = new URLSearchParams();
        for (const [name, fieldValue] of data) {
          params.append(name, typeof fieldValue === 'string' ? fieldValue : fieldValue.name);
        }
        url.search = params.toString();
      }
      value = url.href;
    } else {
      return null;
    }
    const url = new URL(value, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
