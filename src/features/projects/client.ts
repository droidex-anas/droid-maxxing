import { useSyncExternalStore } from 'react';
import { bridge } from '../../lib/bridge';
import type { ServerEvent } from '../../types/bridge';
import type { ProjectCommand, ProjectEvent } from './protocol';
import type { ProjectView, ThreadInput } from './types';

type Result = Extract<ProjectEvent, { type: 'project.result'; ok: true }>;
interface Snapshot {
  projects: ProjectView[];
  loading: boolean;
  error?: string;
}

let snapshot: Snapshot = { projects: [], loading: true };
let initialized = false;
const listeners = new Set<() => void>();
const pending = new Map<
  string,
  {
    resolve: (result: Result) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

export function useProjects(): Snapshot {
  initialize();
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

export function refreshProjects(): void {
  initialize();
  bridge.send({ type: 'projects.list' });
}

export async function createProject(input: ThreadInput): Promise<string> {
  const result = await send({ type: 'project.create', requestId: crypto.randomUUID(), input });
  if (!result.projectId) throw new Error('The runtime did not identify the new project.');
  return result.projectId;
}

export async function spawnThread(
  source: string,
  input: Omit<ThreadInput, 'cwd'>,
): Promise<string> {
  const result = await send({
    type: 'project.spawn',
    requestId: crypto.randomUUID(),
    source,
    input,
  });
  if (!result.appSessionId) throw new Error('The runtime did not identify the new thread.');
  return result.appSessionId;
}

export async function pauseProject(
  projectId: string,
  paused: boolean,
  acknowledgeDelivery = false,
): Promise<void> {
  await send({
    type: 'project.pause',
    requestId: crypto.randomUUID(),
    projectId,
    paused,
    acknowledgeDelivery,
  });
}

export async function stopThread(source: string, target: string): Promise<void> {
  await send({ type: 'project.stop', requestId: crypto.randomUUID(), source, target });
}

function initialize(): void {
  if (initialized) return;
  initialized = true;
  bridge.subscribe(handleEvent);
  bridge.send({ type: 'projects.list' });
}

function handleEvent(event: ServerEvent): void {
  if (event.type === 'projects.snapshot') {
    snapshot = { projects: event.projects, loading: false };
    listeners.forEach((listener) => {
      listener();
    });
  } else if (event.type === 'connection' && event.status === 'connected') {
    refreshProjects();
  } else if (event.type === 'error' && event.code?.startsWith('project.')) {
    snapshot = { ...snapshot, loading: false, error: event.message };
    listeners.forEach((listener) => {
      listener();
    });
  } else if (event.type === 'project.result') {
    const waiter = pending.get(event.requestId);
    if (!waiter) return;
    pending.delete(event.requestId);
    clearTimeout(waiter.timeout);
    if (event.ok) waiter.resolve(event);
    else waiter.reject(new Error(event.error));
  }
}

function send(command: Exclude<ProjectCommand, { type: 'projects.list' }>): Promise<Result> {
  initialize();
  if (pending.size >= 32)
    return Promise.reject(new Error('Wait for the current Projects requests to finish.'));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(command.requestId);
      reject(
        new Error(
          'The request was not acknowledged. Check the project before retrying; the thread may already exist.',
        ),
      );
    }, 30_000);
    pending.set(command.requestId, { resolve, reject, timeout });
    // Mutations must not be replayed from the transport's offline queue.
    if (bridge.sendIfConnected(command)) return;
    pending.delete(command.requestId);
    clearTimeout(timeout);
    reject(new Error('DROIDEX is not connected. Your draft has been kept.'));
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
