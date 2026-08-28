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
let receivedSupervisorStatus = false;

function emit(): void {
  for (const listener of listeners) listener();
}

export function applySidecarStatus(next: SidecarSupervisorSnapshot): void {
  receivedSupervisorStatus = true;
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

function sidecarSupervisorPresent(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.droidControl?.sidecarStatus === 'function';
}

export function canRunAgents(): boolean {
  // No supervisor means browser/Vite: treating that as down disables send permanently.
  if (!receivedSupervisorStatus && !sidecarSupervisorPresent()) return true;
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
  void getSidecarStatus().then(
    (status) => {
      if (status) applySidecarStatus(status);
    },
    (error: unknown) => {
      const reason =
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Agent runtime status is unavailable.';
      applySidecarStatus({
        lifecycle: 'recovery-required',
        processAlive: false,
        bridgeResponsive: false,
        lastHeartbeatAt: supervisor.lastHeartbeatAt,
        restartCount: supervisor.restartCount,
        reason,
      });
    },
  );
}

export function resetRuntimeHealthForTests(): void {
  supervisor = {
    lifecycle: 'starting',
    processAlive: false,
    bridgeResponsive: false,
    lastHeartbeatAt: null,
    restartCount: 0,
  };
  transport = 'disconnected';
  hasConnectedTransport = false;
  subscribed = false;
  receivedSupervisorStatus = false;
  listeners.clear();
}
