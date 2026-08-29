import type {
  LiveChildIdentity,
  LiveRuntimeJournal,
  LiveSessionIdentity,
} from './liveRuntimeJournal.js';
import type { InterruptedSessionRecord, SessionPhase, SessionSummary } from './protocol.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { errMsg } from './sessionHelpers.js';
import type { SessionLifecycle } from './SessionLifecycle.js';
import { adoptedSessionFacts, isDueForRetirement } from './sessionRuntimeRetirement.js';

const TURN_INTERRUPTED =
  'The agent runtime restarted and this turn did not continue. Send a message to resume.';
const SESSION_UNAVAILABLE =
  'The agent runtime restarted and could not reconnect this session. Reopen it to continue.';
const CHILD_INTERRUPTED = 'The agent runtime restarted and this child agent did not continue.';

const ACTIVE_PHASES = new Set<SessionPhase>([
  'running',
  'planning',
  'initializing',
  'orchestrator_turn',
]);

export interface SessionAdoptionDependencies {
  journal: LiveRuntimeJournal;
  registry: {
    liveSessionsSnapshot(): readonly {
      summary: SessionSummary;
      binding?: { providerSessionId?: string };
    }[];
    getCanonicalSummary(id: string): SessionSummary | undefined;
    getLive(id: string): { summary: SessionSummary } | undefined;
  };
  lifecycle: Pick<SessionLifecycle, 'resume'>;
  liveChildren: () => readonly LiveChildIdentity[];
  persistSummaries: (summaries: SessionSummary[]) => void;
  emitStatus: (appSessionId: string, text: string) => void;
  sessionRuntimeIdleMs: number;
  now: () => number;
}

export interface SessionAdoptionResult {
  interrupted: InterruptedSessionRecord[];
}

export class SessionAdoption {
  private started: Promise<SessionAdoptionResult> | null = null;
  private readonly interrupted: InterruptedSessionRecord[] = [];

  constructor(private readonly dependencies: SessionAdoptionDependencies) {}

  records(): readonly InterruptedSessionRecord[] {
    return this.interrupted;
  }

  adopt(): Promise<SessionAdoptionResult> {
    this.started ??= this.adoptOnce();
    return this.started;
  }

  persistLiveSet(): void {
    const sessions: LiveSessionIdentity[] = this.dependencies.registry
      .liveSessionsSnapshot()
      .flatMap((live) => {
        const providerSessionId = live.binding?.providerSessionId ?? live.summary.providerSessionId;
        if (!providerSessionId) return [];
        return [
          {
            appSessionId: live.summary.appSessionId,
            providerSessionId,
            phase: live.summary.phase,
            streaming: live.summary.streaming === true,
            lastActiveAt: live.summary.updatedAt,
          },
        ];
      });
    this.dependencies.journal.write({
      sessions,
      children: [...this.dependencies.liveChildren()],
    });
  }

  private async adoptOnce(): Promise<SessionAdoptionResult> {
    const identities = this.dependencies.journal.read();
    for (const session of identities.sessions) {
      if (!this.shouldResurrect(session, identities.children)) continue;
      await this.adoptSession(session);
    }
    for (const child of identities.children) this.markChildInterrupted(child);
    this.persistLiveSet();
    return { interrupted: [...this.interrupted] };
  }

  // Resurrecting a session already past the idle budget would spawn a provider
  // process for the first sweep to release moments later, so a restart would
  // pay a process and its memory per session to reclaim them seconds after.
  // Leaving it closed costs the user nothing the restart had not already cost:
  // the transcript is served from history and the session reopens on its next
  // prompt exactly as a retired one does. The retirement rules take this
  // decision so there is one owner of it rather than an adoption-shaped copy.
  private shouldResurrect(
    identity: LiveSessionIdentity,
    children: readonly LiveChildIdentity[],
  ): boolean {
    const facts = adoptedSessionFacts({
      appSessionId: identity.appSessionId,
      phase: identity.phase,
      streaming: identity.streaming,
      lastActiveAt: identity.lastActiveAt,
      hasUnsettledChildren: children.some(
        (child) =>
          child.parentAppSessionId === identity.appSessionId &&
          (child.status === 'running' || child.status === 'pending'),
      ),
    });
    const { now, sessionRuntimeIdleMs } = this.dependencies;
    return !isDueForRetirement(facts, now(), sessionRuntimeIdleMs);
  }

  private async adoptSession(identity: LiveSessionIdentity): Promise<void> {
    const historical = this.dependencies.registry.getCanonicalSummary(identity.appSessionId);
    const wasActive = identity.streaming || ACTIVE_PHASES.has(identity.phase);
    try {
      const resumed = await this.dependencies.lifecycle.resume(identity.appSessionId);
      if (!resumed) {
        this.markSessionInterrupted(identity, historical, wasActive, SESSION_UNAVAILABLE);
        return;
      }
      if (!wasActive) return;
      const live = this.dependencies.registry.getLive(identity.appSessionId);
      if (!live) {
        this.markSessionInterrupted(identity, historical, true, SESSION_UNAVAILABLE);
        return;
      }
      const updated: SessionSummary = {
        ...live.summary,
        streaming: false,
        phase: interruptedPhase(live.summary.phase),
        interruptReason: TURN_INTERRUPTED,
      };
      this.dependencies.persistSummaries([updated]);
      live.summary = updated;
      this.interrupted.push({
        appSessionId: identity.appSessionId,
        reason: TURN_INTERRUPTED,
      });
      this.dependencies.emitStatus(identity.appSessionId, TURN_INTERRUPTED);
    } catch (error) {
      this.markSessionInterrupted(
        identity,
        historical,
        wasActive,
        `${SESSION_UNAVAILABLE} (${errMsg(error)})`,
      );
    }
  }

  private markSessionInterrupted(
    identity: LiveSessionIdentity,
    historical: SessionSummary | undefined,
    wasActive: boolean,
    reason: string,
  ): void {
    const base = historical ?? syntheticSummary(identity);
    const updated: SessionSummary = {
      ...base,
      streaming: false,
      phase: wasActive ? interruptedPhase(base.phase) : base.phase,
      interruptReason: reason,
    };
    this.dependencies.persistSummaries([updated]);
    this.interrupted.push({ appSessionId: identity.appSessionId, reason });
    this.dependencies.emitStatus(identity.appSessionId, reason);
  }

  private markChildInterrupted(identity: LiveChildIdentity): void {
    if (identity.status !== 'running') return;
    this.interrupted.push({
      appSessionId: identity.parentAppSessionId,
      childSessionId: identity.childSessionId,
      reason: CHILD_INTERRUPTED,
    });
  }
}

function interruptedPhase(phase: SessionPhase): SessionPhase {
  if (phase === 'completed' || phase === 'failed' || phase === 'paused') return phase;
  return 'paused';
}

function syntheticSummary(identity: LiveSessionIdentity): SessionSummary {
  const now = Date.now();
  return {
    appSessionId: identity.appSessionId,
    providerSessionId: identity.providerSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: `Session ${identity.providerSessionId.slice(0, 8)}`,
    goal: '',
    cwd: '',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'off',
    }),
    phase: 'paused',
    streaming: false,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}
