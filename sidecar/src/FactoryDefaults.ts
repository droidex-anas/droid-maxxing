import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { normalizeCompactionTokenLimit } from './compaction.js';
import type {
  Autonomy,
  FactoryDefaultSettings,
  ReasoningEffort,
  SessionInteractionMode,
} from './protocol.js';
import { objectValue, stringValue } from './values.js';

export type FactoryDefaults = FactoryDefaultSettings;

export type FactorySessionLaunchSettings = Pick<
  FactoryDefaultSettings,
  'modelId' | 'reasoningEffort'
>;

const FACTORY_SESSIONS_ROOT = (): string => join(homedir(), '.factory', 'sessions');
const MAX_SETTINGS_WALK_DEPTH = 4;

export function readFactoryDefaults(): FactoryDefaults {
  const path = join(homedir(), '.factory', 'settings.json');
  if (!existsSync(path)) return {};
  const settings = readJsonObject(path);
  if (!settings) return {};
  const session = objectValue(settings.sessionDefaultSettings) ?? {};
  const missionControlSettings = objectValue(settings.missionModelSettings) ?? {};
  return {
    modelId: stringValue(session.model) || stringValue(session.modelId),
    reasoningEffort: mapReasoning(stringValue(session.reasoningEffort)),
    compactionModel: stringValue(settings.compactionModel) || stringValue(session.compactionModel),
    compactionTokenLimit: tokenLimitValue(settings.compactionTokenLimit),
    compactionTokenLimitPerModel: tokenLimitRecordValue(settings.compactionTokenLimitPerModel),
    autonomy: mapAutonomy(stringValue(session.autonomyLevel)),
    interactionMode: mapInteractionMode(stringValue(session.interactionMode)),
    specModelId: stringValue(session.specModeModel),
    specReasoningEffort: mapReasoning(stringValue(session.specModeReasoningEffort)),
    missionOrchestratorModelId: stringValue(settings.missionOrchestratorModel),
    missionOrchestratorReasoningEffort: mapReasoning(
      stringValue(settings.missionOrchestratorReasoningEffort),
    ),
    workerModelId: stringValue(missionControlSettings.workerModel),
    workerReasoningEffort: mapReasoning(stringValue(missionControlSettings.workerReasoningEffort)),
    validatorModelId: stringValue(missionControlSettings.validationWorkerModel),
    validatorReasoningEffort: mapReasoning(
      stringValue(missionControlSettings.validationWorkerReasoningEffort),
    ),
  };
}

export function readFactorySessionLaunchSettings(
  providerSessionId: string,
): FactorySessionLaunchSettings | undefined {
  const settings = readJsonObject(findFactorySessionSettingsPath(providerSessionId));
  if (!settings) return undefined;
  const modelId = stringValue(settings.modelId) || stringValue(settings.model);
  if (!modelId) return undefined;
  return {
    modelId,
    ...(mapReasoning(stringValue(settings.reasoningEffort))
      ? { reasoningEffort: mapReasoning(stringValue(settings.reasoningEffort)) }
      : {}),
  };
}

function findFactorySessionSettingsPath(providerSessionId: string): string | undefined {
  if (!isSafeSessionFileToken(providerSessionId)) return undefined;
  const root = FACTORY_SESSIONS_ROOT();
  const fileName = `${providerSessionId}.settings.json`;
  const direct = join(root, fileName);
  if (isInside(root, direct) && existsSync(direct)) return direct;
  return walkSettingsPath(root, fileName, 0);
}

function isSafeSessionFileToken(value: string): boolean {
  if (!value || value.includes('\0')) return false;
  if (value.includes('/') || value.includes('\\') || value.includes(sep)) return false;
  return value !== '.' && value !== '..';
}

function isInside(parent: string, candidate: string): boolean {
  const root = resolve(parent);
  const path = relative(root, resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function walkSettingsPath(dir: string, fileName: string, depth: number): string | undefined {
  if (depth > MAX_SETTINGS_WALK_DEPTH || !existsSync(dir)) return undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const path = join(dir, name);
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (name === fileName && !isDirectory) {
      return isInside(FACTORY_SESSIONS_ROOT(), path) ? path : undefined;
    }
    if (isDirectory) {
      const nested = walkSettingsPath(path, fileName, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function readJsonObject(path: string | undefined): Record<string, unknown> | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return objectValue(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

function mapInteractionMode(value?: string): SessionInteractionMode | undefined {
  if (value === 'auto' || value === 'spec' || value === 'agi') return value;
  return undefined;
}

function tokenLimitValue(value: unknown): number | undefined {
  return normalizeCompactionTokenLimit(value);
}

function tokenLimitRecordValue(value: unknown): Record<string, number> | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .map(([modelId, limit]) => [modelId, tokenLimitValue(limit)] as const)
    .filter((entry): entry is [string, number] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mapReasoning(value?: string): ReasoningEffort | undefined {
  if (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic'
  ) {
    return value;
  }
  return undefined;
}

function mapAutonomy(value?: string): Autonomy | undefined {
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}
