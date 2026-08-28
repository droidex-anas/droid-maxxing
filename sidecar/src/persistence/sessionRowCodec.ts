import type { ChildSessionSummary } from '../protocol.js';
import {
  providerDriverKindSchema,
  providerInstanceIdSchema,
  providerDriverKindForInstance,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from '../providers/providerIdentity.js';
import {
  decodePreviousProviderSessionIds,
  decodeResumeState,
  decodeSummaryJson,
  failureFromColumns,
  projectPublicSummary,
  requireNonnegativeInteger,
  requireText,
} from './sessionSummaryJson.js';
import type {
  ProviderBinding,
  SessionLifecycleStatus,
  StoredChildSession,
  StoredSession,
} from './SessionStore.js';

const LIFECYCLE_STATUSES = new Set<SessionLifecycleStatus>([
  'initializing',
  'running',
  'paused',
  'completed',
  'failed',
]);

export function decodeStoredSession(row: unknown): StoredSession {
  const record = asRow(row);
  const appSessionId = requireText(record.app_session_id, 'app_session_id');
  const providerInstanceId = providerInstanceIdSchema.parse(record.provider_instance_id);
  const providerDriverKind = providerDriverKindSchema.parse(record.provider_driver_kind);
  if (providerDriverKind !== providerDriverKindForInstance(providerInstanceId)) {
    throw new Error('provider driver kind does not match instance');
  }
  const json = decodeSummaryJson(
    requireText(record.summary_json, 'summary_json'),
    providerInstanceId,
  );
  const binding = bindingFromRow(record, providerDriverKind, providerInstanceId);
  const lifecycleStatus = lifecycleFromRow(record.lifecycle_status);
  const hidden = requireNonnegativeInteger(record.hidden, 'hidden');
  if (hidden !== 0 && hidden !== 1) throw new Error('hidden must be 0 or 1');
  const stored: StoredSession = {
    summary: projectPublicSummary({
      appSessionId,
      createdAt: requireNonnegativeInteger(record.created_at, 'created_at'),
      updatedAt: requireNonnegativeInteger(record.updated_at, 'updated_at'),
      json,
      binding,
    }),
    binding,
    lifecycleStatus,
    hidden: hidden === 1,
  };
  if (lifecycleStatus === 'failed') {
    stored.failure = failureFromColumns({
      failure_code: record.failure_code,
      failure_message: record.failure_message,
      failure_recovery_action: record.failure_recovery_action,
      provider_instance_id: record.provider_instance_id,
    });
  } else if (
    record.failure_code !== null ||
    record.failure_message !== null ||
    record.failure_recovery_action !== null
  ) {
    throw new Error('non-failed session has failure columns');
  }
  return stored;
}

export function decodeStoredChild(row: unknown): StoredChildSession {
  const record = asRow(row);
  const parentAppSessionId = requireText(record.parent_app_session_id, 'parent_app_session_id');
  const childSessionId = requireText(record.child_session_id, 'child_session_id');
  const providerInstanceId = providerInstanceIdSchema.parse(record.provider_instance_id);
  const providerDriverKind = providerDriverKindSchema.parse(record.provider_driver_kind);
  const binding = bindingFromRow(record, providerDriverKind, providerInstanceId);
  const json = decodeChildSummaryJson(requireText(record.summary_json, 'summary_json'));
  return {
    summary: {
      parentAppSessionId,
      childSessionId,
      ...json,
    },
    binding,
    lifecycleStatus: lifecycleFromRow(record.lifecycle_status),
  };
}

export function encodeChildSummaryJson(summary: ChildSessionSummary): string {
  const json: Record<string, unknown> = {
    role: summary.role,
    status: summary.status,
    modelId: summary.modelId,
    transcriptAvailable: summary.transcriptAvailable,
    streamFidelity: summary.streamFidelity,
  };
  if (summary.label !== undefined) json.label = summary.label;
  if (summary.prompt !== undefined) json.prompt = summary.prompt;
  if (summary.reasoningEffort !== undefined) json.reasoningEffort = summary.reasoningEffort;
  if (summary.autonomy !== undefined) json.autonomy = summary.autonomy;
  if (summary.spawnLink !== undefined) json.spawnLink = summary.spawnLink;
  if (summary.startedAt !== undefined) json.startedAt = summary.startedAt;
  return JSON.stringify(json);
}

function bindingFromRow(
  record: Record<string, unknown>,
  providerDriverKind: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
): ProviderBinding {
  const binding: ProviderBinding = {
    providerDriverKind,
    providerInstanceId,
    previousProviderSessionIds: decodePreviousProviderSessionIds(
      requireText(record.previous_provider_session_ids_json, 'previous_provider_session_ids_json'),
    ),
    runtimeGeneration: requireNonnegativeInteger(record.runtime_generation, 'runtime_generation'),
  };
  const providerSessionId = record.provider_session_id;
  if (typeof providerSessionId === 'string' && providerSessionId.length > 0) {
    binding.providerSessionId = providerSessionId;
  }
  const resumeState = decodeResumeState(
    record.resume_state_json === null
      ? null
      : requireText(record.resume_state_json, 'resume_state_json'),
  );
  if (resumeState !== undefined) binding.resumeState = resumeState;
  return binding;
}

function lifecycleFromRow(value: unknown): SessionLifecycleStatus {
  const status = requireText(value, 'lifecycle_status');
  if (!LIFECYCLE_STATUSES.has(status as SessionLifecycleStatus)) {
    throw new Error(`unknown lifecycle status ${status}`);
  }
  return status as SessionLifecycleStatus;
}

function asRow(row: unknown): Record<string, unknown> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error('row is not an object');
  }
  return row as Record<string, unknown>;
}

function decodeChildSummaryJson(
  raw: string,
): Omit<ChildSessionSummary, 'parentAppSessionId' | 'childSessionId'> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('child summary_json must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const role = record.role;
  const status = record.status;
  const modelId = requireText(record.modelId, 'modelId');
  if (role !== 'worker' && role !== 'validator') throw new Error('child role is invalid');
  if (
    status !== 'pending' &&
    status !== 'running' &&
    status !== 'paused' &&
    status !== 'completed'
  ) {
    throw new Error('child status is invalid');
  }
  const streamFidelity = record.streamFidelity;
  if (streamFidelity !== 'token' && streamFidelity !== 'tool' && streamFidelity !== 'state') {
    throw new Error('child streamFidelity is invalid');
  }
  if (typeof record.transcriptAvailable !== 'boolean') {
    throw new Error('child transcriptAvailable must be boolean');
  }
  const summary: Omit<ChildSessionSummary, 'parentAppSessionId' | 'childSessionId'> = {
    role,
    status,
    modelId,
    transcriptAvailable: record.transcriptAvailable,
    streamFidelity,
  };
  if (typeof record.label === 'string') summary.label = record.label;
  if (typeof record.prompt === 'string') summary.prompt = record.prompt;
  if (typeof record.reasoningEffort === 'string') {
    summary.reasoningEffort = record.reasoningEffort as ChildSessionSummary['reasoningEffort'];
  }
  if (typeof record.autonomy === 'string') {
    summary.autonomy = record.autonomy as ChildSessionSummary['autonomy'];
  }
  if (record.spawnLink && typeof record.spawnLink === 'object') {
    summary.spawnLink = record.spawnLink as ChildSessionSummary['spawnLink'];
  }
  if (typeof record.startedAt === 'number') summary.startedAt = record.startedAt;
  return summary;
}
