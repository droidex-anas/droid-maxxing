import type { DroidStreamEvent, ProgressLogEntry } from '@factory/droid-sdk';

import { bridgeFeature } from '../../missionFeatures.js';
import type { BridgeFeature, ProgressEntry } from '../../protocol.js';

export interface NormalizedProgressEntry extends ProgressEntry {
  workerProviderSessionId?: string;
  spawnId?: string;
}

export interface DroidMissionNormalized {
  features?: BridgeFeature[];
  progress?: NormalizedProgressEntry[];
  missionState?: string;
  missionChild?: {
    event: 'started' | 'completed';
    providerSessionId: string;
    exitCode?: number;
  };
}

export function mapProgress(entries: ProgressLogEntry[]): NormalizedProgressEntry[] {
  return entries.map((entry) => {
    const raw = entry as Record<string, unknown>;
    const workerProviderSessionId =
      typeof raw.workerSessionId === 'string' ? raw.workerSessionId : undefined;
    const spawnId = typeof raw.spawnId === 'string' ? raw.spawnId : undefined;
    return {
      type: String(raw.type ?? 'entry'),
      timestamp: String(raw.timestamp ?? new Date().toISOString()),
      title: typeof raw.title === 'string' ? raw.title : undefined,
      message:
        typeof raw.message === 'string'
          ? raw.message
          : typeof raw.summary === 'string'
            ? raw.summary
            : undefined,
      featureId: typeof raw.featureId === 'string' ? raw.featureId : undefined,
      ...(workerProviderSessionId ? { workerProviderSessionId } : {}),
      ...(spawnId ? { spawnId } : {}),
    };
  });
}

export function normalizeMissionStreamEvent(ev: DroidStreamEvent): DroidMissionNormalized | null {
  switch (ev.type) {
    case 'mission_features_changed':
      return { features: ev.features.map(bridgeFeature) };
    case 'mission_progress_entry':
      return { progress: mapProgress(ev.progressLog) };
    case 'mission_state_changed':
      return { missionState: ev.state };
    case 'mission_worker_started':
      return {
        missionChild: { event: 'started', providerSessionId: ev.workerSessionId },
      };
    case 'mission_worker_completed':
      return {
        missionChild: {
          event: 'completed',
          providerSessionId: ev.workerSessionId,
          exitCode: ev.exitCode,
        },
      };
    default:
      return null;
  }
}
