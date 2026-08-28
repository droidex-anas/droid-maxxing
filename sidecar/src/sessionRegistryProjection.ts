import type { BridgeFeature, SessionSummary } from './protocol.js';
import type { ProviderBinding } from './persistence/SessionStore.js';
import { sessionWebUrlFor } from './persistence/sessionWebUrl.js';
import {
  providerDriverKindForInstance,
  type ProviderDriverKind,
} from './providers/providerIdentity.js';
import { uniqueStrings } from './sessionHelpers.js';

type IdentityField =
  | 'appSessionId'
  | 'providerSessionId'
  | 'compactedFromProviderSessionIds'
  | 'missionId'
  | 'sessionWebUrl';

export type SessionSummaryPatch = Omit<Partial<SessionSummary>, IdentityField>;

export function liveBindingFromSummary(summary: SessionSummary): ProviderBinding {
  const providerInstanceId = summary.configuration.providerSelection.providerInstanceId;
  return {
    providerDriverKind: providerDriverKindForInstance(providerInstanceId),
    providerInstanceId,
    ...(summary.providerSessionId ? { providerSessionId: summary.providerSessionId } : {}),
    previousProviderSessionIds: [...(summary.compactedFromProviderSessionIds ?? [])],
    runtimeGeneration: summary.providerSessionId ? 1 : 0,
  };
}

export function factoryFacingSummary(
  summary: SessionSummary,
  binding: ProviderBinding,
): SessionSummary {
  return {
    ...summary,
    ...(binding.providerSessionId ? { providerSessionId: binding.providerSessionId } : {}),
    ...(binding.previousProviderSessionIds.length > 0
      ? { compactedFromProviderSessionIds: [...binding.previousProviderSessionIds] }
      : {}),
  };
}

export function projectWireSessionSummary(
  summary: SessionSummary,
  projectSummary: (summary: Readonly<SessionSummary>) => SessionSummary,
  binding?: ProviderBinding,
): SessionSummary {
  const canonical = copySummary(summary);
  const projected = projectSummary(canonical);
  const merged = copySummary({ ...canonical, ...withoutIdentityFields(projected) });
  delete merged.providerSessionId;
  delete merged.compactedFromProviderSessionIds;
  const nativeId = binding?.providerSessionId ?? summary.providerSessionId;
  const driver = binding?.providerDriverKind ?? driverForSummary(summary);
  const url = sessionWebUrlFor({ providerDriverKind: driver, providerSessionId: nativeId });
  if (url) merged.sessionWebUrl = url;
  else delete merged.sessionWebUrl;
  return merged;
}

export function withoutIdentityFields(patch: Partial<SessionSummary>): SessionSummaryPatch {
  const safePatch = { ...patch };
  delete safePatch.appSessionId;
  delete safePatch.providerSessionId;
  delete safePatch.compactedFromProviderSessionIds;
  delete safePatch.missionId;
  delete safePatch.sessionWebUrl;
  return safePatch;
}

export function copySummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    ...(summary.compactedFromProviderSessionIds
      ? { compactedFromProviderSessionIds: [...summary.compactedFromProviderSessionIds] }
      : {}),
    features: summary.features.map(copyFeature),
  };
}

export function providerIds(summary: SessionSummary): string[] {
  return uniqueStrings([
    summary.providerSessionId,
    ...(summary.compactedFromProviderSessionIds ?? []),
  ]);
}

export function nativeIds(binding: ProviderBinding, summary: SessionSummary): string[] {
  return uniqueStrings([
    binding.providerSessionId,
    ...binding.previousProviderSessionIds,
    ...providerIds(summary),
  ]);
}

function driverForSummary(summary: SessionSummary): ProviderDriverKind {
  return providerDriverKindForInstance(summary.configuration.providerSelection.providerInstanceId);
}

function copyFeature(feature: BridgeFeature): BridgeFeature {
  return {
    ...feature,
    preconditions: [...feature.preconditions],
    expectedBehavior: [...feature.expectedBehavior],
    verificationSteps: [...feature.verificationSteps],
    ...(feature.fulfills ? { fulfills: [...feature.fulfills] } : {}),
  };
}
