import type { Autonomy, ReasoningEffort } from '../protocol.js';
import type { ProviderKind } from '../providers/providerKind.js';

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
  // The owner is another top-level conversation, not a harness subagent.
  ownerAppSessionId?: string;
  title: string;
  reply: string;
  waiting: boolean;
}

export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  kind: 'result' | 'question' | 'message';
  text: string;
}

export interface Project {
  id: string;
  title: string;
  paused: boolean;
  wakesLeft: number;
  launching: number;
  threads: ProjectThread[];
  pending: ThreadMessage[];
  delivery?: { state: 'sending' | 'uncertain'; messages: ThreadMessage[] };
  error?: string;
}

export interface ProjectView {
  id: string;
  title: string;
  paused: boolean;
  wakesLeft: number;
  launching: number;
  threads: Omit<ProjectThread, 'reply'>[];
  queued: number;
  uncertain: number;
  uncertainTargets: string[];
  error?: string;
}

export type ProjectCommand =
  | { type: 'projects.list' }
  | { type: 'project.create'; requestId: string; input: ThreadInput }
  | { type: 'project.spawn'; requestId: string; source: string; input: Omit<ThreadInput, 'cwd'> }
  | { type: 'project.send'; requestId: string; source: string; target: string; text: string }
  | { type: 'project.ask'; requestId: string; source: string; text: string }
  | { type: 'project.stop'; requestId: string; source: string; target: string }
  | {
      type: 'project.pause';
      requestId: string;
      projectId: string;
      paused: boolean;
      acknowledgeDelivery?: boolean;
    };

export type ProjectEvent =
  | { type: 'projects.snapshot'; projects: ProjectView[] }
  | {
      type: 'project.result';
      requestId: string;
      ok: true;
      projectId?: string;
      appSessionId?: string;
    }
  | { type: 'project.result'; requestId: string; ok: false; error: string };
