import {
  getSidecarStatus,
  onSidecarStatus,
  type SidecarLifecycle,
  type SidecarSupervisorSnapshot,
} from './desktop';

export type TransportHealth = 'connected' | 'disconnected';

export interface RuntimeHealthSnapshot {
  lifecycle: SidecarLifecycle;
  transport: TransportHealth;
  processAlive: boolean;
  bridgeResponsive: boolean;
  lastHeartbeatAt: number | null;
  restartCount: number;
  reason?: string;
}

const listeners = new Set<() => void>();

let supervisor: SidecarSupervisorSnapshot = {
  lifecycle: 'starting',
  processAlive: false,
  bridgeResponsive: false,
  lastHeartbeatAt: null,
  restartCount: 0,
};
let transport: TransportHealth = 'disconnected';
let hasConnectedTransport = false;
let subscribed = false;

function emit(): void {
  for (const listener of listeners) listener();
}

export function applySidecarStatus(next: SidecarSupervisorSnapshot): void {
  supervisor = next;
  emit();
}

export function setTransportHealth(next: TransportHealth): void {
  if (next === 'connected') hasConnectedTransport = true;
  if (transport === next) return;
  transport = next;
  emit();
}

export function hasConnectedAgentTransport(): boolean {
  return hasConnectedTransport;
}

export function getRuntimeHealth(): RuntimeHealthSnapshot {
  return {
    lifecycle: supervisor.lifecycle,
    transport,
    processAlive: supervisor.processAlive,
    bridgeResponsive: supervisor.bridgeResponsive,
    lastHeartbeatAt: supervisor.lastHeartbeatAt,
    restartCount: supervisor.restartCount,
    ...(supervisor.reason ? { reason: supervisor.reason } : {}),
  };
}

export function canRunAgents(): boolean {
  const health = getRuntimeHealth();
  if (health.lifecycle === 'healthy' || health.lifecycle === 'degraded') {
    return health.transport === 'connected';
  }
  return false;
}

export function subscribeRuntimeHealth(listener: () => void): () => void {
  ensureSidecarSubscription();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function ensureSidecarSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  onSidecarStatus(applySidecarStatus);
  void getSidecarStatus().then((status) => {
    if (status) applySidecarStatus(status);
  });
}
