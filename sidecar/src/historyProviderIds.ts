const INVALID_PROVIDER_SESSION_ALIASES =
  'Canonical history contains invalid provider-session aliases.';

export function decodeProviderSessionIdList(
  value: unknown,
  invalidMessage = INVALID_PROVIDER_SESSION_ALIASES,
): string[] {
  if (typeof value !== 'string' || value.length === 0) throw new Error(invalidMessage);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error(invalidMessage);
    const providerSessionIds: string[] = [];
    for (const providerSessionId of parsed) {
      if (typeof providerSessionId !== 'string' || providerSessionId.length === 0) {
        throw new Error(invalidMessage);
      }
      providerSessionIds.push(providerSessionId);
    }
    return providerSessionIds;
  } catch {
    throw new Error(invalidMessage);
  }
}
