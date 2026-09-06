// Single construction path for BridgeFeature. Its sources — SDK mission events
// over JSON-RPC and mission `features.json` on disk — are both untrusted at
// runtime, so validation lives here rather than in each caller. Keeping it out
// of `normalize.ts` also keeps the SDK runtime out of the history worker.
import type { BridgeFeature, FeatureStatus } from './protocol.js';
import { objectValue, trimmedString } from './values.js';

export function bridgeFeature(value: unknown): BridgeFeature {
  const f = objectValue(value) ?? {};
  const id = trimmedString(f.id);
  const milestone = trimmedString(f.milestone);
  const fulfills = Array.isArray(f.fulfills) ? stringArray(f.fulfills) : undefined;
  return {
    id: id ?? 'feature',
    description: trimmedString(f.description) ?? id ?? 'Feature',
    status: featureStatus(trimmedString(f.status)),
    skillName: trimmedString(f.skillName) ?? '',
    preconditions: stringArray(f.preconditions),
    expectedBehavior: stringArray(f.expectedBehavior),
    verificationSteps: stringArray(f.verificationSteps),
    ...(fulfills ? { fulfills } : {}),
    ...(milestone ? { milestone } : {}),
  };
}

function featureStatus(status?: string): FeatureStatus {
  if (status === 'in_progress' || status === 'completed' || status === 'cancelled') return status;
  return 'pending';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
