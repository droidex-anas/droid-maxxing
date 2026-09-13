// Which agent runtime a session runs on. Bound once when the session is created
// and never changed afterwards. Kept dependency-free: the history worker bundles
// this module and must pull in no third-party runtime.
export const PROVIDER_KINDS = ['droid', 'claude', 'codex'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const DEFAULT_PROVIDER: ProviderKind = 'droid';

// Lenient reader for persisted data: a stored session file written by an older
// or newer build may carry anything, and an unrecognized binding reads as absent.
export function providerKind(value: unknown): ProviderKind | undefined {
  return PROVIDER_KINDS.find((kind) => kind === value);
}

// session.create may omit the binding, but a provider this build cannot route is
// a caller bug: fail the create instead of quietly running on Droid.
export function requireProviderKind(value: unknown): ProviderKind {
  if (value === undefined) return DEFAULT_PROVIDER;
  const provider = providerKind(value);
  if (provider) return provider;
  const description = typeof value === 'string' ? value : typeof value;
  throw new Error(`Unsupported session provider: ${description}`);
}

export function assertProviderUnchanged(settings: object): void {
  if ('provider' in settings) {
    throw new Error('A session provider is chosen at creation and cannot be changed.');
  }
}
