/* global location */

import redaction from '../browserRedaction.cjs';

export { isSensitiveBrowserKey, redactBrowserDiagnosticUrl, sanitizeUrl, agentVisibleUrl };

const { isSensitiveBrowserKey, redactBrowserDiagnosticUrl } = redaction;

function sanitizeUrl(value) {
  return redactBrowserDiagnosticUrl(value, location.href);
}

function agentVisibleUrl() {
  return redactBrowserDiagnosticUrl(location.href);
}
