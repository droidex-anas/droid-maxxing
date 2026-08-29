import type { SessionRole } from '../../protocol.js';
import type { ProviderEventAdmissionLive, ProviderRuntimeEvent } from '../providerEvents.js';
import type { SessionEventFlow } from '../../SessionEventFlow.js';
import { hotPathMetrics } from '../../telemetry/hotPathMetrics.js';
import {
  normalizeNotification,
  normalizeStreamEvent,
  providerEventsFromNormalized,
  type DroidStreamEvent,
  type NormalizedEvent,
} from './DroidEventAdapter.js';

export class DroidEventFlow {
  constructor(private readonly eventFlow: Pick<SessionEventFlow, 'apply' | 'beginTurn' | 'forgetSession'>) {}

  beginTurn(appSessionId: string, sourceProviderSessionId: string): void {
    this.eventFlow.beginTurn(appSessionId, sourceProviderSessionId);
  }

  forgetSession(appSessionId: string): void {
    this.eventFlow.forgetSession(appSessionId);
  }

  applyStreamEvent(
    appSessionId: string,
    sourceProviderSessionId: string,
    role: SessionRole,
    event: DroidStreamEvent,
    childSessionId?: string,
  ): void {
    const normalizeStartedAt = performance.now();
    const normalized = normalizeStreamEvent(appSessionId, sourceProviderSessionId, role, event);
    hotPathMetrics.recordNormalize(performance.now() - normalizeStartedAt);
    if (normalized) this.#applyNormalized(appSessionId, sourceProviderSessionId, role, normalized, childSessionId);
  }

  applyNotification(
    appSessionId: string,
    sourceProviderSessionId: string,
    role: SessionRole,
    notification: Record<string, unknown>,
    childSessionId?: string,
  ): void {
    const normalizeStartedAt = performance.now();
    const notifications = normalizeNotification(
      appSessionId,
      sourceProviderSessionId,
      role,
      notification,
    );
    hotPathMetrics.recordNormalize(performance.now() - normalizeStartedAt);
    for (const normalized of notifications) {
      this.#applyNormalized(appSessionId, sourceProviderSessionId, role, normalized, childSessionId);
    }
  }

  #applyNormalized(
    appSessionId: string,
    sourceProviderSessionId: string,
    role: SessionRole,
    normalized: NormalizedEvent,
    childSessionId?: string,
  ): void {
    const base = eventBase(appSessionId, sourceProviderSessionId, role, childSessionId);
    const live = admissionFor(base);
    if (normalized.done) {
      this.eventFlow.apply(
        {
          ...base,
          eventId: `${base.eventId}:settled`,
          type: 'turn.settled',
          settlement: { status: 'completed' },
        } satisfies ProviderRuntimeEvent,
        live,
      );
      return;
    }
    for (const event of providerEventsFromNormalized(normalized, base)) {
      this.eventFlow.apply({ ...event, eventId: nextConvertedId() }, live);
    }
  }
}

function eventBase(
  appSessionId: string,
  sourceProviderSessionId: string,
  role: SessionRole,
  childSessionId?: string,
) {
  return {
    eventId: nextConvertedId(),
    target:
      childSessionId || role !== 'primary'
        ? {
            kind: 'child' as const,
            parentAppSessionId: appSessionId,
            childSessionId: childSessionId ?? sourceProviderSessionId,
          }
        : { kind: 'session' as const, appSessionId },
    providerDriverKind: 'droid' as const,
    providerInstanceId: 'droid' as const,
    runtimeGeneration: 1,
    createdAt: Date.now(),
    nativeCorrelation: { sessionId: sourceProviderSessionId },
  };
}

function admissionFor(base: ReturnType<typeof eventBase>): ProviderEventAdmissionLive {
  return {
    target: base.target,
    providerDriverKind: base.providerDriverKind,
    providerInstanceId: base.providerInstanceId,
    runtimeGeneration: base.runtimeGeneration,
    settledTurnIds: new Set<string>(),
  };
}

let convertedSeq = 0;
const nextConvertedId = () => `droid-flow-${Date.now().toString(36)}-${(convertedSeq++).toString(36)}`;
