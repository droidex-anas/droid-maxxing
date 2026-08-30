import type { ProviderInstanceId } from '../../types/bridge';

export const HARNESS_ORDER = [
  'droid',
  'codex',
  'claude',
  'cursor',
  'grok',
] as const satisfies readonly ProviderInstanceId[];

export const HARNESS_DISPLAY_NAME: Record<ProviderInstanceId, string> = {
  droid: 'Droid',
  codex: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  grok: 'Grok',
};

export function isProviderInstanceId(value: unknown): value is ProviderInstanceId {
  return (
    value === 'droid' ||
    value === 'codex' ||
    value === 'claude' ||
    value === 'cursor' ||
    value === 'grok'
  );
}
