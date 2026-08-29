// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/GrokAdapter.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

const PREFERRED_OPTION_KIND = {
  allow_session: 'allow_always',
  allow_once: 'allow_once',
  deny: 'reject_once',
} as const;

export interface GrokPermissionOption {
  optionId: string;
  kind: string;
}

export function selectGrokPermissionOptionId(
  options: readonly GrokPermissionOption[],
  decision: keyof typeof PREFERRED_OPTION_KIND,
): string | undefined {
  const preferredKind = PREFERRED_OPTION_KIND[decision];
  const preferred = options.find((entry) => entry.kind === preferredKind)?.optionId.trim();
  if (preferred) {
    return preferred;
  }
  if (decision === 'allow_session') {
    return options.find((entry) => entry.kind === 'allow_once')?.optionId.trim();
  }
  return undefined;
}

export function grokPermissionFingerprint(input: {
  kind?: string;
  title?: string;
  command?: string;
  rawInput?: unknown;
  locations?: unknown;
}): string | undefined {
  let operationInput = input.rawInput;
  if (isPlainObject(operationInput) && operationInput.variant === 'Bash') {
    const { description: _description, ...shellInput } = operationInput;
    operationInput = shellInput;
  }
  const hasInput = isPlainObject(operationInput) && Object.keys(operationInput).length > 0;
  if (!input.command && !hasInput) {
    return undefined;
  }
  return stableJson({
    kind: input.kind,
    title: input.title,
    command: input.command,
    input: operationInput,
    locations: input.locations,
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    return JSON.stringify(String(value));
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
