import { useSyncExternalStore } from 'react';
import { bridge } from '../../lib/bridge';
import type { ClientCommand, ServerEvent } from '../../types/bridge';
import type { AutomationBridgeCommand, AutomationBridgeEvent } from './protocol';
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
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
let requestCounter = 0;

export function useAutomationSnapshot(): AutomationSnapshot {
  initialize();
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function requestAutomationSnapshot(): void {
  initialize();
  sendRaw({ type: 'automations.list', requestId: newRequestId() });
}

export function createAutomation(input: AutomationDraft): Promise<void> {
  return send({ type: 'automations.create', requestId: newRequestId(), input });
}

export function updateAutomation(id: string, patch: Partial<AutomationDraft>): Promise<void> {
  return send({ type: 'automations.update', requestId: newRequestId(), id, patch });
}

export function deleteAutomation(id: string): Promise<void> {
  return send({ type: 'automations.delete', requestId: newRequestId(), id });
}

export function setAutomationEnabled(id: string, enabled: boolean): Promise<void> {
  return send({ type: 'automations.setEnabled', requestId: newRequestId(), id, enabled });
}

export function runAutomationNow(id: string): Promise<void> {
  return send({ type: 'automations.runNow', requestId: newRequestId(), id });
}

export function confirmAutomationProposal(id: string, input?: AutomationDraft): Promise<void> {
  return send({
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
  const automationEvent = asAutomationEvent(event);
  if (!automationEvent) return;
  if (automationEvent.type === 'automations.snapshot') {
    snapshot = automationEvent.snapshot;
    listeners.forEach((listener) => {
      listener();
    });
    return;
  }
  const waiter = pending.get(automationEvent.requestId);
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  pending.delete(automationEvent.requestId);
  if (automationEvent.ok) waiter.resolve();
  else waiter.reject(new Error(automationEvent.error ?? 'Automation request failed.'));
}

// Every command routed through here mutates automations, so it must never sit in
// the bridge's offline queue: a replay after reconnect would create, delete, or
// re-run an automation minutes after the caller's request already failed.
function send(command: AutomationBridgeCommand): Promise<void> {
  initialize();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(command.requestId);
      reject(new Error('DROIDEX did not acknowledge the automation request.'));
    }, 10_000);
    pending.set(command.requestId, { resolve, reject, timeout });
    if (bridge.sendIfConnected(command as unknown as ClientCommand)) return;
    clearTimeout(timeout);
    pending.delete(command.requestId);
    reject(new Error('DROIDEX is not connected.'));
  });
}

function sendRaw(command: AutomationBridgeCommand): void {
  bridge.send(command as unknown as ClientCommand);
}

function asAutomationEvent(event: ServerEvent): AutomationBridgeEvent | null {
  const candidate = event as unknown as { type?: unknown };
  if (typeof candidate.type !== 'string' || !candidate.type.startsWith('automations.')) {
    return null;
  }
  return event as unknown as AutomationBridgeEvent;
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
