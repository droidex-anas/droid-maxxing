import type { ProjectView, ThreadInput } from './types';

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
