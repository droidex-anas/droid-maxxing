// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/GrokAcpSupport.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { z } from 'zod';

import type { AcpHandshakeOptions } from '../acp/AcpConnection.js';
import type { AcpProcessSpawnRequest } from '../acp/acpProcess.js';
import type { Autonomy } from '../../protocol.js';
import {
  defineProviderCapabilities,
  type ProviderCapabilities,
  type ProviderDefinition,
} from '../providerTypes.js';

export const GROK_DEFINITION: ProviderDefinition = {
  providerDriverKind: 'grok',
  providerInstanceId: 'grok',
  displayName: 'Grok',
};

export const GROK_DEFAULT_BINARY = 'grok';
export const GROK_DEFAULT_MODEL_ID = 'grok-build';
export const GROK_RESUME_SCHEMA_VERSION = 1;
export const GROK_VERSION_TIMEOUT_MS = 4_000;
export const GROK_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
export const GROK_TURN_INACTIVITY_MS = 10 * 60 * 1_000;
export const GROK_ACTIVE_TOOL_INACTIVITY_MS = 30 * 60 * 1_000;

export const GROK_AUTH_METHOD_API_KEY = 'xai.api_key';
export const GROK_AUTH_METHOD_CACHED_TOKEN = 'cached_token';
export const GROK_API_KEY_ENV = 'XAI_API_KEY';
export const GROK_OAUTH2_REFERRER_ENV = 'GROK_OAUTH2_REFERRER';
export const GROK_OAUTH2_REFERRER = 'droidex';

export const GROK_ACP_CLIENT_INFO = {
  name: 'DROIDEX',
  version: '1.1.5',
} as const;

export const GROK_MODEL_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export const GROK_SPAWN_ARGS_BY_AUTONOMY = {
  off: ['--permission-mode', 'default', 'agent', 'stdio'],
  low: ['--permission-mode', 'acceptEdits', 'agent', 'stdio'],
  medium: ['--permission-mode', 'auto', 'agent', 'stdio'],
  high: ['agent', '--always-approve', 'stdio'],
} as const satisfies Record<Autonomy, readonly string[]>;

export const GROK_DEFAULT_SPAWN_ARGS = ['agent', 'stdio'] as const;

export interface GrokResumeState {
  schemaVersion: 1;
  sessionId: string;
}

export interface GrokSpawnSettings {
  binaryPath?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  autonomy?: Autonomy;
}

const resumeStateSchema = z
  .object({
    schemaVersion: z.literal(GROK_RESUME_SCHEMA_VERSION),
    sessionId: z.string().min(1),
  })
  .strict();

export function grokCapabilities(): ProviderCapabilities {
  return defineProviderCapabilities({
    modes: ['auto'],
    autonomyLevels: ['off', 'low', 'medium', 'high'],
    modelChange: 'before_turn',
    resume: true,
    steer: false,
    interrupt: true,
    approvals: true,
    questions: true,
    planReview: true,
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

export function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv = process.env): string {
  return environment[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export function grokAcpSpawnArgs(autonomy?: Autonomy): readonly string[] {
  if (autonomy === undefined) {
    return GROK_DEFAULT_SPAWN_ARGS;
  }
  return GROK_SPAWN_ARGS_BY_AUTONOMY[autonomy];
}

export function buildGrokAcpSpawn(settings: GrokSpawnSettings): AcpProcessSpawnRequest {
  const command = settings.binaryPath?.trim() ? settings.binaryPath.trim() : GROK_DEFAULT_BINARY;
  const env: NodeJS.ProcessEnv = {
    ...settings.env,
    [GROK_OAUTH2_REFERRER_ENV]: GROK_OAUTH2_REFERRER,
  };
  return {
    command,
    args: [...grokAcpSpawnArgs(settings.autonomy)],
    cwd: settings.cwd,
    env,
  };
}

export function buildGrokHandshake(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  resumeSessionId?: string;
}): AcpHandshakeOptions {
  return {
    authMethodId: resolveGrokAuthMethodId(input.env),
    cwd: input.cwd,
    clientInfo: GROK_ACP_CLIENT_INFO,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
  };
}

export function isValidGrokModelToken(value: string): boolean {
  return GROK_MODEL_TOKEN.test(value);
}

export function resolveGrokAcpBaseModelId(model: string | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : GROK_DEFAULT_MODEL_ID;
}

export function encodeGrokResumeState(sessionId: string): GrokResumeState {
  return { schemaVersion: GROK_RESUME_SCHEMA_VERSION, sessionId };
}

export function parseGrokResumeState(value: unknown): GrokResumeState | undefined {
  const parsed = resumeStateSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return { schemaVersion: 1, sessionId: parsed.data.sessionId.trim() };
}
