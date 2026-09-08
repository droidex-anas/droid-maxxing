import { useSyncExternalStore } from 'react';
import { bridge } from '../../lib/bridge';
import type { ServerEvent } from '../../types/bridge';
import type { AutomationBridgeCommand } from './protocol';
import type { AutomationDraft, AutomationSnapshot } from './types';

const EMPTY: AutomationSnapshot = {
  automations: [],
  runs: [],
  proposals: [],
  sessionOrigins: {},
  queuedRunCount: 0,
  activeRunCount: 0,
  scheduler: { ready: false, nextWakeAt: null, activeRunId: null },
};
let snapshot = EMPTY;
let initialized = false;
const listeners = new Set<() => void>();
const pending = new Map<
  string,
  {
    resolve: (result: AutomationCommandResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
let requestCounter = 0;

interface AutomationCommandResult {
  runId?: string;
}

export function useAutomationSnapshot(): AutomationSnapshot {
  initialize();
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function requestAutomationSnapshot(): void {
  initialize();
  bridge.send({ type: 'automations.list', requestId: newRequestId() });
}

export async function createAutomation(input: AutomationDraft): Promise<void> {
  await send({ type: 'automations.create', requestId: newRequestId(), input });
}

export async function updateAutomation(id: string, patch: Partial<AutomationDraft>): Promise<void> {
  await send({ type: 'automations.update', requestId: newRequestId(), id, patch });
}

export async function deleteAutomation(id: string): Promise<void> {
  await send({ type: 'automations.delete', requestId: newRequestId(), id });
}

export async function setAutomationEnabled(id: string, enabled: boolean): Promise<void> {
  await send({ type: 'automations.setEnabled', requestId: newRequestId(), id, enabled });
}

export async function runAutomationNow(id: string): Promise<string> {
  const result = await send({ type: 'automations.runNow', requestId: newRequestId(), id });
  if (!result.runId) throw new Error('DROIDEX did not identify the queued automation run.');
  return result.runId;
}

export async function confirmAutomationProposal(
  id: string,
  input?: AutomationDraft,
): Promise<void> {
  await send({
    type: 'automations.confirmProposal',
    requestId: newRequestId(),
    id,
    ...(input ? { input } : {}),
  });
}

function initialize(): void {
  if (initialized) return;
  initialized = true;
  bridge.subscribe(handleEvent);
  requestAutomationSnapshot();
}

function handleEvent(event: ServerEvent): void {
  if (event.type === 'automations.snapshot') {
    snapshot = event.snapshot;
    listeners.forEach((listener) => {
      listener();
    });
    return;
  }
  if (event.type === 'connection' && event.status === 'connected') {
    requestAutomationSnapshot();
    return;
  }
  if (event.type !== 'automations.result') return;
  const waiter = pending.get(event.requestId);
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  pending.delete(event.requestId);
  if (event.ok) waiter.resolve(event.runId ? { runId: event.runId } : {});
  else waiter.reject(new Error(event.error));
}

// Every command routed through here mutates automations, so it must never sit in
// the bridge's offline queue: a replay after reconnect would create, delete, or
// re-run an automation minutes after the caller's request already failed.
function send(command: AutomationBridgeCommand): Promise<AutomationCommandResult> {
  initialize();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(command.requestId);
      reject(new Error('DROIDEX did not acknowledge the automation request.'));
    }, 10_000);
    pending.set(command.requestId, { resolve, reject, timeout });
    if (bridge.sendIfConnected(command)) return;
    clearTimeout(timeout);
    pending.delete(command.requestId);
    reject(new Error('DROIDEX is not connected.'));
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AutomationSnapshot {
  return snapshot;
}

function newRequestId(): string {
  return `automation-${Date.now().toString(36)}-${String(requestCounter++)}`;
}
