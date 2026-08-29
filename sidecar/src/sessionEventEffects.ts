import type { BridgeFeature } from './protocol.js';
import type { ProviderRuntimeEvent, ProviderSessionEffect } from './providers/providerEvents.js';
import type { NormalizedProgressEntry } from './providers/droid/DroidMissionSignals.js';
import { detectChildSession, taskResultChildUpdate, type ChildSessionSignal } from './subagentSignals.js';

export interface NormalizedSideEffects {
  features?: BridgeFeature[];
  progress?: NormalizedProgressEntry[];
  missionState?: string;
  missionChild?: {
    event: 'started' | 'completed';
    providerSessionId: string;
    exitCode?: number;
  };
  childSession?: ChildSessionSignal;
}

export interface NormalizedTokenUsage {
  tokensIn: number;
  tokensOut: number;
  contextTokens?: number;
}

export function hasSideEffects(sideEffects: NormalizedSideEffects): boolean {
  return Boolean(
    sideEffects.features ??
    sideEffects.progress ??
    sideEffects.missionState ??
    sideEffects.missionChild ??
    sideEffects.childSession,
  );
}

export function sideEffectsFromProviderEvent(event: ProviderRuntimeEvent): NormalizedSideEffects {
  if (event.type === 'transcript') {
    const childSession = detectChildSession(
      event.event.toolName,
      asRecord(event.event.toolArgs),
      undefined,
      event.event.toolUseId,
    );
    const resultUpdate = taskResultChildUpdate(event.event.toolName, event.event.text);
    if (!childSession && !resultUpdate) return {};
    return {
      childSession: {
        ...(childSession ?? {}),
        ...(resultUpdate?.providerSessionId
          ? { providerSessionId: resultUpdate.providerSessionId }
          : {}),
        ...(resultUpdate ? { done: resultUpdate.done } : {}),
      },
    };
  }
  if (event.type !== 'session.effect') return {};
  return sideEffectsFromSessionEffect(event.effect);
}

function sideEffectsFromSessionEffect(effect: ProviderSessionEffect): NormalizedSideEffects {
  if (effect.kind === 'child_upsert') {
    return {
      childSession: {
        providerSessionId: effect.child.spawnLink?.id,
        label: effect.child.label,
        prompt: effect.child.prompt,
        done: effect.child.status === 'completed',
        activity: effect.child.activity,
      },
    };
  }
  if (effect.kind !== 'observational_task') return {};
  if (effect.label === 'mission-worker' || effect.label === 'mission-worker-completed') {
    return {
      missionChild: {
        event: effect.status === 'completed' ? 'completed' : 'started',
        providerSessionId: effect.taskId,
      },
    };
  }
  if (effect.label === 'mission-state' && effect.preview) {
    return { missionState: effect.preview };
  }
  if (effect.label === 'mission-features' && effect.preview) {
    try {
      const features = JSON.parse(effect.preview) as NormalizedSideEffects['features'];
      return features ? { features } : {};
    } catch {
      return {};
    }
  }
  if (effect.label === 'mission-progress' && effect.preview) {
    try {
      const progress = JSON.parse(effect.preview) as NormalizedSideEffects['progress'];
      return progress ? { progress } : {};
    } catch {
      return {};
    }
  }
  const toolUseId = effect.preview && !effect.preview.includes(':') ? effect.preview : undefined;
  const providerSessionId = toolUseId && effect.taskId === toolUseId ? undefined : effect.taskId;
  return {
    childSession: {
      ...(providerSessionId ? { providerSessionId } : {}),
      label: effect.label,
      done: effect.status === 'completed' || effect.status === 'failed',
      ...(toolUseId ? { toolUseId } : {}),
      ...(effect.preview && effect.preview.includes(':')
        ? { activity: { preview: effect.preview } }
        : {}),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
