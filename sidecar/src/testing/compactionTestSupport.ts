import { ReasoningEffort } from '@factory/droid-sdk';

import type { FactorySession } from '../providers/droid/DroidProviderSession.js';
import type { LiveSession } from '../SessionLifecycle.js';
import { liveBindingFromSummary } from '../SessionRegistry.js';
import { droidSessionConfiguration } from '../providers/providerIdentity.js';
import { StubProviderSession } from './stubProviderSession.js';

export function createCompactionTestLiveSession(
  appSessionId: string,
  session: FactorySession,
): LiveSession {
  const summary = {
    appSessionId,
    providerSessionId: session.sessionId,
    sessionPurpose: 'chat' as const,
    role: 'user' as const,
    title: appSessionId,
    goal: 'test',
    cwd: '/workspace',
    workspaceKind: 'folder' as const,
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      reasoningEffort: ReasoningEffort.Low,
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused' as const,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    maxContextTokens: 1_000,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    summary,
    binding: liveBindingFromSummary(summary),
    session,
    provider: new StubProviderSession(session.sessionId),
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
    mcpServers: [],
    mcpConfigs: [],
  };
}
