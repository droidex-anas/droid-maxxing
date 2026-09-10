/* global document, location, Element, HTMLAnchorElement, HTMLIFrameElement, URL */

import { cleanText, safeElementText } from './dom.js';
import { currentAgentSnapshotTarget } from './agentSnapshot.js';
import { editableFieldSelector, isSensitiveField } from './sensitiveFields.js';

export { inspectAuthenticationIntent };

function inspectAuthenticationIntent(request) {
  try {
    const isEnter = request?.action === 'keypress' && request?.key === 'Enter';
    if (request?.action !== 'click' && !isEnter) return null;
    let target = isEnter ? document.activeElement : null;
    if (!target && typeof request?.selector === 'string') {
      target = currentAgentSnapshotTarget(request.ref, request.selector);
      if (!target) return null;
    }
    if (!target) target = document.elementFromPoint(Number(request?.x), Number(request?.y));
    if (!(target instanceof Element)) return null;
    if (target instanceof HTMLIFrameElement) {
      try {
        const targetOrigin = new URL(target.src, location.href).origin;
        if (targetOrigin !== location.origin) {
          return { kind: 'cross_origin_frame', origin: location.origin, targetOrigin };
        }
      } catch {
        return { kind: 'cross_origin_frame', origin: location.origin };
      }
    }
    const control =
      target.closest('button,a,input[type="submit"],input[type="button"],input[type="image"]') ||
      target;
    const form = control.form || control.closest?.('form') || target.closest?.('form');
    const label = cleanText(
      control.getAttribute?.('aria-label') ||
        control.getAttribute?.('title') ||
        (isSensitiveField(control) ? '[redacted]' : control.value) ||
        safeElementText(control) ||
        form?.getAttribute?.('aria-label') ||
        '',
      100,
    );
    const context = cleanText(
      `${label} ${form ? safeElementText(form, 500) : ''}`,
      500,
    ).toLowerCase();
    let kind;
    if (/passkey|security key|touch id|webauthn/.test(context)) kind = 'passkey';
    else if (
      /(continue|sign in|log in|sign up).{0,24}(google|apple|microsoft|github|facebook|oauth)/.test(
        context,
      )
    )
      kind = 'oauth';
    else if (/sign up|register|create (?:an )?account|join now/.test(context)) kind = 'signup';
    else if (
      (isEnter ||
        control.matches?.(
          'button,input[type="submit"],input[type="button"],input[type="image"]',
        )) &&
      Array.from(form?.querySelectorAll(editableFieldSelector) || []).some(isSensitiveField)
    ) {
      kind = 'signin';
    }
    if (!kind) return null;
    const targetUrl = kind === 'oauth' ? authoritativeAuthenticationTarget(control, form) : null;
    return targetUrl
      ? { kind, origin: location.origin, label, targetUrl }
      : { kind, origin: location.origin, label };
  } catch {
    return null;
  }
}

function authoritativeAuthenticationTarget(control, form) {
  let value;
  if (control instanceof HTMLAnchorElement) value = control.href;
  else if (form) value = control.formAction || form.action;
  if (!value) return null;
  try {
    const url = new URL(value, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
