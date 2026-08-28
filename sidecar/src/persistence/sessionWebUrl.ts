import type { ProviderDriverKind } from '../providers/providerIdentity.js';

const DROID_SESSION_WEB_URL_PREFIX = 'https://app.factory.ai/sessions/';

export function sessionWebUrlFor(input: {
  providerDriverKind: ProviderDriverKind;
  providerSessionId?: string;
}): string | undefined {
  if (input.providerDriverKind !== 'droid') return undefined;
  const nativeId = input.providerSessionId;
  if (!nativeId) return undefined;
  return `${DROID_SESSION_WEB_URL_PREFIX}${nativeId}`;
}

export function droidSessionIdFromWebUrl(url: string): string | undefined {
  if (!url.startsWith(DROID_SESSION_WEB_URL_PREFIX)) return undefined;
  const id = url.slice(DROID_SESSION_WEB_URL_PREFIX.length);
  return id.length > 0 && !id.includes('/') ? id : undefined;
}
