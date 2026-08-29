import type { ChildPersistence } from './childCanonicalPersistence.js';
import type { FactoryRuntime } from './providers/droid/DroidProviderAdapter.js';
import type { ServerEvent, SessionSummary } from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { SessionTimeline } from './SessionTimeline.js';
import type { DroidEventFlow } from './providers/droid/DroidEventFlow.js';
import type { DroidInteractions } from './providers/droid/DroidInteractions.js';
import type { SessionContext } from './SessionContext.js';
import type { SessionCompaction } from './SessionCompaction.js';
import type { SessionInitResult } from './sessionHelpers.js';
import type {
  ChildParentLease,
  ChildRuntimeTarget,
  ChildSettings,
  PersistedChildSession,
} from './ChildSessionState.js';

export type ChildOperation = 'open' | 'loadHistory' | 'send' | 'sendNow' | 'interrupt' | 'settings';

export type ChildSettingsTarget = ChildRuntimeTarget & {
  parentGeneration: number;
  runtimeGeneration: number;
  configurationGeneration?: number;
};

export interface ChildSessionsDependencies {
  runtime: Pick<FactoryRuntime, 'loadSession'>;
  registry: Pick<SessionRegistry<ChildParentLease>, 'getLive'>;
  childPersistence: ChildPersistence;
  readLaunchSettings(providerSessionId: string): ChildSettings | undefined;
  timeline: Pick<
    SessionTimeline,
    'append' | 'appendStatus' | 'loadChildHistory' | 'flushStreamingFor' | 'settleStreaming'
  >;
  eventFlow: Pick<DroidEventFlow, 'beginTurn' | 'applyNotification' | 'applyStreamEvent'>;
  interactions: Pick<DroidInteractions, 'makePermissionHandler' | 'makeAskUserHandler'>;
  context: Pick<SessionContext, 'forgetChild' | 'refresh' | 'startPolling' | 'stopPolling'>;
  compaction: Pick<
    SessionCompaction,
    | 'afterTurn'
    | 'arm'
    | 'cancel'
    | 'forgetChild'
    | 'handleChildNotification'
    | 'rearmModelChangedChild'
    | 'resolveLimit'
  >;
  resolveDefaultSettings(
    summary: SessionSummary,
    initResult: SessionInitResult,
    role: PersistedChildSession['role'],
  ): ChildSettings;
  isShutdownStarted(): boolean;
  emit(event: ServerEvent): void;
  nextChildSessionId(): string;
  maxOpenSessions: number;
  maxLiveRuntimes: number;
  maxQueuedRuntimes: number;
  childRuntimeIdleMs: number;
  now(): number;
}
