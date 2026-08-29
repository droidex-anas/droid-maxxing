import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ClientCommand, SessionSummary } from './protocol.js';
import {
  assertDroidMissionConfigurationAllowed,
  droidSessionConfiguration,
  parseSessionConfiguration,
  providerSelectionsEqual,
} from './providers/providerIdentity.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');

type ForbiddenSummaryField =
  | 'modelId'
  | 'reasoningEffort'
  | 'interactionMode'
  | 'autonomy'
  | 'workerModelId'
  | 'workerReasoningEffort'
  | 'validatorModelId'
  | 'validatorReasoningEffort'
  | 'providerDriverKind'
  | 'providerInstanceId';

type ForbiddenCreateField =
  | 'interactionMode'
  | 'modelId'
  | 'reasoningEffort'
  | 'autonomy'
  | 'workerModel'
  | 'workerReasoning'
  | 'validatorModel'
  | 'validatorReasoning';

type SummaryForbiddenPresent = Extract<keyof SessionSummary, ForbiddenSummaryField>;
type CreateCommand = Extract<ClientCommand, { type: 'session.create' }>;
type UpdateCommand = Extract<ClientCommand, { type: 'session.updateSettings' }>;
type CreateForbiddenPresent = Extract<keyof CreateCommand, ForbiddenCreateField>;
type UpdateForbiddenPresent = Extract<
  keyof UpdateCommand,
  'modelId' | 'reasoningEffort' | 'autonomy' | 'interactionMode'
>;

type AssertNever<T> = [T] extends [never] ? true : T;

const _summaryHasNoTopLevelProviderFields: AssertNever<SummaryForbiddenPresent> = true;
const _createHasNoParallelProviderInputs: AssertNever<CreateForbiddenPresent> = true;
const _updateIsFullReplacement: AssertNever<UpdateForbiddenPresent> = true;
void _summaryHasNoTopLevelProviderFields;
void _createHasNoParallelProviderInputs;
void _updateIsFullReplacement;

function extractBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

function assertAbsent(source: string, patterns: readonly string[], label: string): void {
  for (const pattern of patterns) {
    assert.equal(source.includes(pattern), false, `${label} still contains ${pattern}`);
  }
}

test('a summary without a complete configuration is rejected rather than coerced to droid', () => {
  assert.throws(() => parseSessionConfiguration({ interactionMode: 'auto', autonomy: 'medium' }));
  assert.throws(() =>
    parseSessionConfiguration({
      interactionMode: 'auto',
      autonomy: 'medium',
      providerSelection: { modelId: 'model-a', options: {} },
    }),
  );
  const missingSelection = parseSessionConfiguration as (value: unknown) => unknown;
  assert.throws(() =>
    missingSelection({
      interactionMode: 'auto',
      autonomy: 'medium',
    }),
  );
});

test('top-level provider kind/instance, model/reasoning, mode/autonomy, and generic worker/validator fields are absent from both protocol mirrors', () => {
  const protocol = readFileSync(join(here, 'protocol.ts'), 'utf8');
  const bridge = readFileSync(join(repoRoot, 'src/types/bridge.ts'), 'utf8');

  const protocolSummary = extractBlock(
    protocol,
    'export interface SessionSummary {',
    '\nexport interface TranscriptEvent',
  );
  const bridgeSummary = extractBlock(
    bridge,
    'export interface SessionSummary {',
    '\nexport interface TranscriptEvent',
  );

  const forbiddenSummary = [
    '  modelId?:',
    '  reasoningEffort?:',
    '  interactionMode:',
    '  autonomy:',
    '  workerModelId?:',
    '  workerReasoningEffort?:',
    '  validatorModelId?:',
    '  validatorReasoningEffort?:',
    '  providerDriverKind',
    '  providerInstanceId',
  ];
  assertAbsent(protocolSummary, forbiddenSummary, 'protocol SessionSummary');
  assertAbsent(bridgeSummary, forbiddenSummary, 'bridge SessionSummary');
  assert.match(protocolSummary, /configuration: SessionConfiguration;/);
  assert.match(bridgeSummary, /configuration: SessionConfiguration;/);
  assert.match(protocolSummary, /droidMissionConfiguration\?: DroidMissionConfiguration;/);
  assert.match(bridgeSummary, /droidMissionConfiguration\?: DroidMissionConfiguration;/);

  const protocolCreate = extractBlock(protocol, "type: 'session.create';", "type: 'session.send';");
  const bridgeCreate = extractBlock(bridge, "type: 'session.create';", "type: 'session.send';");
  const forbiddenCreate = [
    'interactionMode?:',
    'modelId?:',
    'reasoningEffort?:',
    'autonomy:',
    'workerModel?:',
    'workerReasoning?:',
    'validatorModel?:',
    'validatorReasoning?:',
  ];
  assertAbsent(protocolCreate, forbiddenCreate, 'protocol session.create');
  assertAbsent(bridgeCreate, forbiddenCreate, 'bridge session.create');
  assert.match(protocolCreate, /configuration: SessionConfiguration;/);
  assert.match(bridgeCreate, /configuration: SessionConfiguration;/);
  assert.match(protocolCreate, /compactionModel\?: string;/);
  assert.match(bridgeCreate, /compactionModel\?: string;/);

  const protocolUpdate = extractBlock(
    protocol,
    "type: 'session.updateSettings';",
    "type: 'session.compact';",
  );
  const bridgeUpdate = extractBlock(
    bridge,
    "type: 'session.updateSettings';",
    "type: 'session.compact';",
  );
  const forbiddenUpdate = ['modelId?:', 'reasoningEffort?:', 'autonomy?:', 'interactionMode?:'];
  assertAbsent(protocolUpdate, forbiddenUpdate, 'protocol session.updateSettings');
  assertAbsent(bridgeUpdate, forbiddenUpdate, 'bridge session.updateSettings');
  assert.match(protocolUpdate, /appSessionId: string;/);
  assert.match(protocolUpdate, /configuration: SessionConfiguration;/);
  assert.match(bridgeUpdate, /appSessionId: string;/);
  assert.match(bridgeUpdate, /configuration: SessionConfiguration;/);
  assert.equal(protocolUpdate.includes('modelId'), false);
  assert.equal(bridgeUpdate.includes('modelId'), false);
});

test('Droid Mission configuration is rejected on a non-Droid or non-AGI summary', () => {
  const mission = {
    worker: { modelId: 'worker-a', reasoningEffort: 'high' as const },
    validator: { modelId: 'validator-a' },
  };
  const agiDroid = droidSessionConfiguration({
    modelId: 'model-a',
    interactionMode: 'agi',
    autonomy: 'high',
  });
  assert.doesNotThrow(() => assertDroidMissionConfigurationAllowed(agiDroid, mission));
  assert.throws(
    () =>
      assertDroidMissionConfigurationAllowed(
        droidSessionConfiguration({
          modelId: 'model-a',
          interactionMode: 'auto',
          autonomy: 'high',
        }),
        mission,
      ),
    /droidMissionConfiguration is valid only/,
  );
  assert.throws(
    () =>
      assertDroidMissionConfigurationAllowed(
        {
          ...agiDroid,
          providerSelection: { ...agiDroid.providerSelection, providerInstanceId: 'codex' },
        },
        mission,
      ),
    /droidMissionConfiguration is valid only/,
  );
});

test('equal modelId values remain different selections when the instance differs', () => {
  const droid = droidSessionConfiguration({
    modelId: 'shared-model',
    interactionMode: 'auto',
    autonomy: 'low',
  }).providerSelection;
  const cursor = {
    ...droid,
    providerInstanceId: 'cursor' as const,
  };
  assert.equal(droid.modelId, cursor.modelId);
  assert.equal(providerSelectionsEqual(droid, cursor), false);
});
