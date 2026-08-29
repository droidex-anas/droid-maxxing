import type { TranscriptEvent } from './protocol.js';
import {
  admitProviderRuntimeEvent,
  parseProviderRuntimeEvent,
  sessionTargetsEqual,
  type ProviderEventAdmissionLive,
  type ProviderRuntimeEvent,
} from './providers/providerEvents.js';
import {
  hasSideEffects,
  sideEffectsFromProviderEvent,
  type NormalizedSideEffects,
  type NormalizedTokenUsage,
} from './sessionEventEffects.js';

export type { NormalizedSideEffects, NormalizedTokenUsage };

export interface SessionEventFlowDependencies {
  appendTranscript: (event: TranscriptEvent) => void;
  flushTranscript: (appSessionId: string, sourceSessionId: string) => void;
  applySideEffects: (appSessionId: string, sideEffects: NormalizedSideEffects) => void;
  recordUsage: (
    appSessionId: string,
    sourceProviderSessionId: string,
    usage: NormalizedTokenUsage,
  ) => void;
}

const POST_TERMINAL_GENERATION_KINDS = new Set(['text', 'thinking', 'tool_call', 'tool_result']);

export class SessionEventFlow {
  private readonly terminalSources = new Map<string, Set<string>>();
  private readonly seenEventIds = new Map<string, Set<string>>();
  private readonly settledTurns = new Map<string, Set<string>>();

  constructor(private readonly dependencies: SessionEventFlowDependencies) {}

  beginTurn(appSessionId: string, sourceProviderSessionId: string): void {
    this.terminalSources.get(appSessionId)?.delete(sourceProviderSessionId);
  }

  apply(event: unknown, live: ProviderEventAdmissionLive): void {
    if (!isPlainObject(event) || hasRejectedNativeFields(event)) return;
    let parsed: ProviderRuntimeEvent;
    try {
      parsed = parseProviderRuntimeEvent(event);
    } catch {
      return;
    }
    if (!sessionTargetsEqual(parsed.target, live.target)) return;
    const admission = admitProviderRuntimeEvent(parsed, {
      ...live,
      settledTurnIds: this.settledTurnIds(live, parsed),
    });
    if (!admission.ok) return;
    const appSessionId = appSessionIdOf(parsed);
    const seen = this.eventIds(appSessionId);
    if (seen.has(parsed.eventId)) return;
    seen.add(parsed.eventId);
    this.applyAdmitted(parsed, appSessionId);
  }

  forgetSession(appSessionId: string): void {
    this.terminalSources.delete(appSessionId);
    this.seenEventIds.delete(appSessionId);
    this.settledTurns.delete(appSessionId);
  }

  private applyAdmitted(event: ProviderRuntimeEvent, appSessionId: string): void {
    if (event.type === 'turn.settled') {
      if (event.turnId !== undefined) this.turnScope(appSessionId).add(event.turnId);
      this.terminalScope(appSessionId).add(sourceIdOf(event));
      return;
    }
    if (event.type === 'binding.updated' || event.type === 'warning' || event.type === 'error') {
      return;
    }
    const sourceId = sourceIdOf(event);
    const terminal = this.terminalSources.get(appSessionId)?.has(sourceId) === true;
    if (event.type === 'transcript') {
      const transcript = this.transcriptFrom(event, appSessionId, sourceId);
      const blocked = terminal && isPostTerminalGeneration(transcript);
      if (!blocked) this.dependencies.appendTranscript(transcript);
    }
    if (event.type === 'usage') {
      this.dependencies.recordUsage(appSessionId, sourceId, {
        tokensIn: event.inputTokens,
        tokensOut: event.outputTokens,
        ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
      });
    }
    this.flushThenApply(
      appSessionId,
      sourceId,
      event.target.kind === 'child',
      sideEffectsFromProviderEvent(event),
    );
  }

  private flushThenApply(
    appSessionId: string,
    sourceId: string,
    isChild: boolean,
    sideEffects: NormalizedSideEffects,
  ): void {
    if (!hasSideEffects(sideEffects)) return;
    try {
      this.dependencies.flushTranscript(appSessionId, isChild ? sourceId : appSessionId);
    } catch {
      // Provider notifications are synchronous SDK callbacks. Persistence
      // failures are already reported and remain owned by turn settlement;
      // never let a callback consume or rethrow that sticky failure.
      return;
    }
    this.dependencies.applySideEffects(appSessionId, sideEffects);
  }

  private transcriptFrom(
    event: Extract<ProviderRuntimeEvent, { type: 'transcript' }>,
    appSessionId: string,
    sourceId: string,
  ): TranscriptEvent {
    const sourceSessionId = event.target.kind === 'child' ? event.target.childSessionId : sourceId;
    return {
      id: event.eventId,
      appSessionId,
      sourceSessionId,
      ts: event.createdAt,
      ...event.event,
    };
  }

  private settledTurnIds(
    live: ProviderEventAdmissionLive,
    event: ProviderRuntimeEvent,
  ): ReadonlySet<string> {
    const appSessionId = appSessionIdOf(event);
    const local = this.settledTurns.get(appSessionId);
    if (!local) return live.settledTurnIds;
    const merged = new Set(live.settledTurnIds);
    for (const turnId of local) merged.add(turnId);
    return merged;
  }

  private eventIds(appSessionId: string): Set<string> {
    const existing = this.seenEventIds.get(appSessionId);
    if (existing) return existing;
    const created = new Set<string>();
    this.seenEventIds.set(appSessionId, created);
    return created;
  }

  private turnScope(appSessionId: string): Set<string> {
    const existing = this.settledTurns.get(appSessionId);
    if (existing) return existing;
    const created = new Set<string>();
    this.settledTurns.set(appSessionId, created);
    return created;
  }

  private terminalScope(appSessionId: string): Set<string> {
    const existing = this.terminalSources.get(appSessionId);
    if (existing) return existing;
    const created = new Set<string>();
    this.terminalSources.set(appSessionId, created);
    return created;
  }
}

function appSessionIdOf(event: ProviderRuntimeEvent): string {
  return event.target.kind === 'session'
    ? event.target.appSessionId
    : event.target.parentAppSessionId;
}

function sourceIdOf(event: ProviderRuntimeEvent): string {
  if (event.target.kind === 'child') return event.target.childSessionId;
  return event.nativeCorrelation?.sessionId ?? event.target.appSessionId;
}

function isPostTerminalGeneration(transcript: TranscriptEvent | undefined): boolean {
  return Boolean(
    transcript && !transcript.isError && POST_TERMINAL_GENERATION_KINDS.has(transcript.kind),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasRejectedNativeFields(value: Record<string, unknown>): boolean {
  return 'raw' in value || 'nativePayload' in value || 'sdkEvent' in value;
}
