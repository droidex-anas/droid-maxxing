// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/GrokProvider.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import { resolveAcpExecutable, wrapAcpInvocation } from '../acp/acpProcess.js';
import { reasoningEffortSchema } from '../providerIdentity.js';
import type { ReasoningEffort } from '../../protocol.js';
import {
  createProviderContractError,
  type ProviderModel,
  type ProviderSnapshot,
} from '../providerTypes.js';
import {
  GROK_DEFAULT_BINARY,
  GROK_DEFAULT_MODEL_ID,
  GROK_DEFINITION,
  GROK_VERSION_TIMEOUT_MS,
  grokCapabilities,
  isValidGrokModelToken,
  resolveGrokAcpBaseModelId,
} from './grokHandshake.js';

const execFileAsync = promisify(execFile);

export interface GrokCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export type GrokCommandRunner = (input: {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<GrokCommandResult>;

const modelInfoSchema = z
  .object({
    modelId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .passthrough();

const sessionModelStateSchema = z
  .object({
    currentModelId: z.string().optional(),
    availableModels: z.array(modelInfoSchema),
  })
  .passthrough();

const sessionSetupModelsSchema = z
  .object({
    models: sessionModelStateSchema.optional(),
  })
  .passthrough();

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export function fallbackGrokModel(): ProviderModel {
  return {
    id: GROK_DEFAULT_MODEL_ID,
    displayName: 'Grok Build',
    isDefault: true,
    supportedReasoningEfforts: [],
    serviceTiers: [],
  };
}

export function parseGrokModelsFromSessionSetup(value: unknown): readonly ProviderModel[] {
  const parsed = sessionSetupModelsSchema.safeParse(value);
  if (!parsed.success || !parsed.data.models) {
    return [fallbackGrokModel()];
  }
  const currentId = parsed.data.models.currentModelId?.trim();
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const entry of parsed.data.models.availableModels) {
    const id = resolveGrokAcpBaseModelId(entry.modelId);
    if (!isValidGrokModelToken(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({
      id,
      displayName: entry.name.trim() || id,
      isDefault: false,
      supportedReasoningEfforts: reasoningEffortsFromMeta(entry._meta),
      serviceTiers: [],
    });
  }
  if (models.length === 0) {
    return [fallbackGrokModel()];
  }
  const defaultIndex = currentId
    ? models.findIndex((model) => model.id === currentId)
    : models.findIndex((model) => model.id === GROK_DEFAULT_MODEL_ID);
  const marked = defaultIndex >= 0 ? defaultIndex : 0;
  return models.map((model, index) => (index === marked ? { ...model, isDefault: true } : model));
}

export async function defaultGrokCommandRunner(input: {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<GrokCommandResult> {
  const resolved = resolveAcpExecutable(input.command);
  if (resolved === undefined) {
    throw createProviderContractError(
      'grok',
      'missing_executable',
      'Grok CLI executable was not found.',
      'open_grok_setup',
    );
  }
  const invocation = wrapAcpInvocation(resolved, [...input.args]);
  try {
    const result = await execFileAsync(invocation.execPath, invocation.execArgs, {
      timeout: input.timeoutMs,
      signal: input.signal,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, timedOut: false };
  } catch (error) {
    return mapExecFailure(error);
  }
}

export async function runGrokVersion(input: {
  command: string;
  runCommand: GrokCommandRunner;
  timeoutMs?: number;
  signal: AbortSignal;
}): Promise<GrokCommandResult> {
  return input.runCommand({
    command: input.command,
    args: ['--version'],
    timeoutMs: input.timeoutMs ?? GROK_VERSION_TIMEOUT_MS,
    signal: input.signal,
  });
}

export function buildGrokSnapshot(input: {
  revision: number;
  version: string | null;
  models: readonly ProviderModel[];
}): ProviderSnapshot {
  return {
    definition: GROK_DEFINITION,
    revision: input.revision,
    readiness: 'ready',
    ...(input.version ? { executable: { name: GROK_DEFAULT_BINARY, version: input.version } } : {}),
    models: input.models,
    capabilities: grokCapabilities(),
  };
}

export function missingGrokExecutableSnapshot(revision: number): ProviderSnapshot {
  return {
    definition: GROK_DEFINITION,
    revision,
    readiness: 'missing',
    models: [fallbackGrokModel()],
    capabilities: grokCapabilities(),
    error: createProviderContractError(
      'grok',
      'missing_executable',
      'Grok CLI executable was not found.',
      'open_grok_setup',
    ).toProviderError(),
  };
}

export function unavailableGrokSnapshot(
  revision: number,
  message: string,
  version: string | null = null,
): ProviderSnapshot {
  return {
    definition: GROK_DEFINITION,
    revision,
    readiness: 'unavailable',
    ...(version ? { executable: { name: GROK_DEFAULT_BINARY, version } } : {}),
    models: [fallbackGrokModel()],
    capabilities: grokCapabilities(),
    error: createProviderContractError(
      'grok',
      'unavailable_provider_instance',
      message,
      'refresh',
    ).toProviderError(),
  };
}

function reasoningEffortsFromMeta(meta: Record<string, unknown> | undefined): ReasoningEffort[] {
  if (!meta || !Array.isArray(meta.reasoningEfforts)) {
    return [];
  }
  const seen = new Set<ReasoningEffort>();
  const efforts: ReasoningEffort[] = [];
  for (const entry of meta.reasoningEfforts) {
    const raw =
      isPlainObject(entry) && typeof entry.value === 'string'
        ? entry.value
        : isPlainObject(entry) && typeof entry.id === 'string'
          ? entry.id
          : undefined;
    if (!raw || !isValidGrokModelToken(raw)) {
      continue;
    }
    const parsed = reasoningEffortSchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data)) {
      continue;
    }
    seen.add(parsed.data);
    efforts.push(parsed.data);
  }
  return efforts;
}

function mapExecFailure(error: unknown): GrokCommandResult {
  if (isErrnoException(error) && error.code === 'ENOENT') {
    throw createProviderContractError(
      'grok',
      'missing_executable',
      'Grok CLI executable was not found.',
      'open_grok_setup',
    );
  }
  if (isErrnoException(error) && error.code === 'ABORT_ERR') {
    throw createProviderContractError(
      'grok',
      'stale_provider_operation',
      'Grok discovery was cancelled.',
      'refresh',
    );
  }
  const timedOut =
    isErrnoException(error) && (error.killed === true || error.code === 'ERR_TIMEOUT');
  if (timedOut) {
    return { stdout: '', stderr: '', code: 1, timedOut: true };
  }
  const stdout = isErrnoException(error) && errorHasText(error, 'stdout') ? error.stdout : '';
  const stderr = isErrnoException(error) && errorHasText(error, 'stderr') ? error.stderr : '';
  const code = isErrnoException(error) && errorHasNumber(error, 'code') ? error.code : 1;
  return { stdout, stderr, code, timedOut: false };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException & {
  killed?: boolean;
  stdout?: string;
  stderr?: string;
} {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorHasText(
  error: object,
  key: 'stdout' | 'stderr',
): error is { stdout: string; stderr: string } {
  return typeof Reflect.get(error, key) === 'string';
}

function errorHasNumber(error: object, key: 'code'): error is { code: number } {
  return typeof Reflect.get(error, key) === 'number';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
