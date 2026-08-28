// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/CursorAcpSupport.ts
// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/CursorProvider.ts
// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/CursorAdapter.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

import type { SessionInteractionMode } from '../../protocol.js';
import type { AcpHandshakeOptions } from '../acp/AcpConnection.js';
import type { AcpProcessSpawnRequest } from '../acp/acpProcess.js';
import {
  defineProviderCapabilities,
  type ProviderCapabilities,
  type ProviderDefinition,
} from '../providerTypes.js';

export const CURSOR_DEFINITION: ProviderDefinition = {
  providerDriverKind: 'cursor',
  providerInstanceId: 'cursor',
  displayName: 'Cursor',
};

export const CURSOR_AUTH_METHOD_ID = 'cursor_login';
export const CURSOR_DEFAULT_BINARY = 'cursor-agent';
export const CURSOR_DEFAULT_MODEL_ID = 'default';
export const CURSOR_RESUME_SCHEMA_VERSION = 1;
export const CURSOR_ABOUT_TIMEOUT_MS = 8_000;
export const CURSOR_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
export const CURSOR_SESSION_LOAD_TIMEOUT_MS = 90_000;

export const CURSOR_ACP_CLIENT_INFO = {
  name: 'DROIDEX',
  version: '1.1.5',
} as const;

export const CURSOR_CLIENT_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} as const;

export const ACP_PLAN_MODE_ALIASES = ['plan', 'architect'] as const;
export const ACP_NORMAL_MODE_ALIASES = ['code', 'agent', 'default', 'chat', 'implement'] as const;

export interface CursorSpawnSettings {
  binaryPath?: string;
  apiEndpoint?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface CursorAdvertisedMode {
  id: string;
  name: string;
  description?: string;
}

export interface CursorResumeState {
  schemaVersion: 1;
  sessionId: string;
}

const advertisedModeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .passthrough();

const advertisedModeStateSchema = z
  .object({
    currentModeId: z.string().min(1),
    availableModes: z.array(advertisedModeSchema),
  })
  .passthrough();

const resumeStateSchema = z
  .object({
    schemaVersion: z.literal(CURSOR_RESUME_SCHEMA_VERSION),
    sessionId: z.string().min(1),
  })
  .strict();

export function buildCursorAcpSpawn(settings: CursorSpawnSettings): AcpProcessSpawnRequest {
  const command = settings.binaryPath?.trim() ? settings.binaryPath.trim() : CURSOR_DEFAULT_BINARY;
  const args = settings.apiEndpoint?.trim() ? ['-e', settings.apiEndpoint.trim(), 'acp'] : ['acp'];
  return {
    command,
    args,
    cwd: settings.cwd,
    ...(settings.env ? { env: settings.env } : {}),
  };
}

export function buildCursorHandshake(input: {
  cwd: string;
  resumeSessionId?: string;
}): AcpHandshakeOptions {
  return {
    authMethodId: CURSOR_AUTH_METHOD_ID,
    cwd: input.cwd,
    clientCapabilities: CURSOR_CLIENT_CAPABILITIES,
    clientInfo: CURSOR_ACP_CLIENT_INFO,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
  };
}

export function resolveCursorAcpBaseModelId(model: string | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : CURSOR_DEFAULT_MODEL_ID;
  const bracket = base.indexOf('[');
  return bracket === -1 ? base : base.slice(0, bracket);
}

export function encodeCursorResumeState(sessionId: string): CursorResumeState {
  return { schemaVersion: CURSOR_RESUME_SCHEMA_VERSION, sessionId };
}

export function parseCursorResumeState(value: unknown): CursorResumeState | undefined {
  const parsed = resumeStateSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return { schemaVersion: 1, sessionId: parsed.data.sessionId.trim() };
}

export function parseAdvertisedModes(sessionSetupResult: unknown): readonly CursorAdvertisedMode[] {
  if (!isPlainObject(sessionSetupResult)) {
    return [];
  }
  const parsed = advertisedModeStateSchema.safeParse(sessionSetupResult.modes);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.availableModes.map((mode) => ({
    id: mode.id.trim(),
    name: mode.name.trim(),
    ...(mode.description?.trim() ? { description: mode.description.trim() } : {}),
  }));
}

export function findModeByAliases(
  modes: readonly CursorAdvertisedMode[],
  aliases: readonly string[],
): CursorAdvertisedMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      return mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

export function resolveCursorSessionModeId(
  interactionMode: SessionInteractionMode,
  advertised: readonly CursorAdvertisedMode[],
): string | undefined {
  if (interactionMode === 'spec') {
    return findModeByAliases(advertised, ACP_PLAN_MODE_ALIASES)?.id;
  }
  if (interactionMode === 'auto') {
    return findModeByAliases(advertised, ACP_NORMAL_MODE_ALIASES)?.id;
  }
  return undefined;
}

export function supportedCursorInteractionModes(
  advertised: readonly CursorAdvertisedMode[],
): SessionInteractionMode[] {
  const modes: SessionInteractionMode[] = [];
  if (findModeByAliases(advertised, ACP_NORMAL_MODE_ALIASES)) {
    modes.push('auto');
  }
  if (findModeByAliases(advertised, ACP_PLAN_MODE_ALIASES)) {
    modes.push('spec');
  }
  return modes;
}

export function cursorCapabilities(modes: readonly SessionInteractionMode[]): ProviderCapabilities {
  return defineProviderCapabilities({
    modes: [...modes],
    autonomyLevels: [],
    modelChange: 'before_turn',
    resume: true,
    steer: false,
    interrupt: true,
    approvals: false,
    questions: false,
    planReview: false,
    context: false,
    compaction: false,
    skills: false,
    slashCommands: false,
    mcpUse: false,
    mcpManagement: false,
    rewind: false,
    fork: false,
    observationalTasks: false,
    addressableChildren: false,
    missionControl: false,
    browser: false,
    usageReporting: false,
    reasoningStream: false,
  });
}

function normalizeModeSearchText(mode: CursorAdvertisedMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
