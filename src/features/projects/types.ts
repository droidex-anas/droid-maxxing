import type { Autonomy, ProviderKind, ReasoningEffort } from '../../types/bridge';

export interface ThreadInput {
  title: string;
  prompt: string;
  provider: ProviderKind;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  autonomy: Autonomy;
  cwd?: string;
}

export interface ProjectThread {
  appSessionId: string;
  ownerAppSessionId?: string;
  title: string;
  waiting: boolean;
}

export interface ProjectView {
  id: string;
  title: string;
  paused: boolean;
  wakesLeft: number;
  launching: number;
  threads: ProjectThread[];
  queued: number;
  uncertain: number;
  uncertainTargets: string[];
  error?: string;
}
