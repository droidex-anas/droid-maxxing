// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/CursorProvider.ts
// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/CursorAcpExtension.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

import {
  createProviderContractError,
  type ProviderModel,
  type ProviderSnapshot,
} from '../providerTypes.js';
import { CURSOR_UNAUTHENTICATED_MESSAGE, type CursorAboutParse } from './cursorAbout.js';
import {
  CURSOR_DEFAULT_BINARY,
  CURSOR_DEFAULT_MODEL_ID,
  CURSOR_DEFINITION,
  cursorCapabilities,
  type CursorAdvertisedMode,
  supportedCursorInteractionModes,
} from './cursorHandshake.js';

const availableModelSchema = z
  .object({
    value: z.string(),
    name: z.string(),
    configOptions: z.array(z.unknown()).optional(),
  })
  .passthrough();

const listAvailableModelsSchema = z
  .object({
    models: z.array(availableModelSchema),
  })
  .passthrough();

export function parseCursorModelCatalog(value: unknown): readonly ProviderModel[] {
  const parsed = listAvailableModelsSchema.safeParse(value);
  if (!parsed.success) {
    return [fallbackCursorModel()];
  }
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const entry of parsed.data.models) {
    const id = entry.value.trim();
    const displayName = entry.name.trim();
    if (!id || !displayName || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({
      id,
      displayName,
      isDefault: false,
      supportedReasoningEfforts: [],
      serviceTiers: [],
    });
  }
  if (models.length === 0) {
    return [fallbackCursorModel()];
  }
  const defaultIndex = models.findIndex((model) => model.id === CURSOR_DEFAULT_MODEL_ID);
  const marked = defaultIndex >= 0 ? defaultIndex : 0;
  return models.map((model, index) => (index === marked ? { ...model, isDefault: true } : model));
}

export function fallbackCursorModel(): ProviderModel {
  return {
    id: CURSOR_DEFAULT_MODEL_ID,
    displayName: 'Default',
    isDefault: true,
    supportedReasoningEfforts: [],
    serviceTiers: [],
  };
}

export function buildCursorSnapshot(input: {
  revision: number;
  parsed: CursorAboutParse;
  models: readonly ProviderModel[];
  advertisedModes: readonly CursorAdvertisedMode[];
}): ProviderSnapshot {
  const capabilities = cursorCapabilities(supportedCursorInteractionModes(input.advertisedModes));
  if (input.parsed.auth.status === 'unauthenticated') {
    return {
      definition: CURSOR_DEFINITION,
      revision: input.revision,
      readiness: 'unauthenticated',
      ...(input.parsed.version
        ? { executable: { name: CURSOR_DEFAULT_BINARY, version: input.parsed.version } }
        : {}),
      models: input.models,
      capabilities,
      error: createProviderContractError(
        'cursor',
        'unauthenticated_provider',
        input.parsed.message ?? CURSOR_UNAUTHENTICATED_MESSAGE,
        'open_cursor_setup',
      ).toProviderError(),
    };
  }

  const auth =
    input.parsed.auth.status === 'authenticated'
      ? {
          accountLabel: input.parsed.auth.email,
          ...(input.parsed.auth.billingLabel
            ? { billingLabel: input.parsed.auth.billingLabel }
            : {}),
        }
      : undefined;

  return {
    definition: CURSOR_DEFINITION,
    revision: input.revision,
    readiness: 'ready',
    ...(input.parsed.version
      ? { executable: { name: CURSOR_DEFAULT_BINARY, version: input.parsed.version } }
      : {}),
    ...(auth ? { auth } : {}),
    models: input.models,
    capabilities,
  };
}

export function missingCursorExecutableSnapshot(revision: number): ProviderSnapshot {
  return {
    definition: CURSOR_DEFINITION,
    revision,
    readiness: 'missing',
    models: [fallbackCursorModel()],
    capabilities: cursorCapabilities([]),
    error: createProviderContractError(
      'cursor',
      'missing_executable',
      'Cursor Agent executable was not found.',
      'open_cursor_setup',
    ).toProviderError(),
  };
}

export function unavailableCursorSnapshot(
  revision: number,
  message: string,
  version: string | null = null,
): ProviderSnapshot {
  return {
    definition: CURSOR_DEFINITION,
    revision,
    readiness: 'unavailable',
    ...(version ? { executable: { name: CURSOR_DEFAULT_BINARY, version } } : {}),
    models: [fallbackCursorModel()],
    capabilities: cursorCapabilities([]),
    error: createProviderContractError(
      'cursor',
      'unavailable_provider_instance',
      message,
      'refresh',
    ).toProviderError(),
  };
}
