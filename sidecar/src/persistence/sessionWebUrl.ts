import type { ProviderSessionRef } from '../protocol.js';
import type { ProviderDriverKind } from '../providers/providerIdentity.js';

const DROID_SESSION_WEB_URL_PREFIX = 'https://app.factory.ai/sessions/';

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sessionWebUrlFor(input: {
  providerDriverKind: ProviderDriverKind;
  providerSessionId?: string;
}): string | undefined {
  if (input.providerDriverKind !== 'droid') return undefined;
  const nativeId = input.providerSessionId;
  if (!nativeId) return undefined;
  return `${DROID_SESSION_WEB_URL_PREFIX}${nativeId}`;
}

export function sessionRefFor(input: {
  providerDriverKind: ProviderDriverKind;
  providerSessionId?: string;
}): ProviderSessionRef | undefined {
  if (input.providerDriverKind !== 'droid') return undefined;
  const nativeId = input.providerSessionId;
  if (!nativeId) return undefined;
  return {
    id: nativeId,
    resumeCommand: `droid -r ${posixSingleQuote(nativeId)}`,
  };
}

export function attachSessionPublicDisplay(
  summary: { sessionWebUrl?: string; sessionRef?: ProviderSessionRef },
  binding: { providerDriverKind: ProviderDriverKind; providerSessionId?: string },
): void {
  const url = sessionWebUrlFor(binding);
  const ref = sessionRefFor(binding);
  if (url) summary.sessionWebUrl = url;
  else delete summary.sessionWebUrl;
  if (ref) summary.sessionRef = { ...ref };
  else delete summary.sessionRef;
}
