import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useRuntimeHealth } from '../hooks/useRuntimeHealth';
import { hasConnectedAgentTransport } from '../lib/runtimeHealth';

export default function RuntimeStatusBanner() {
  const health = useRuntimeHealth();
  const [seenHealthy, setSeenHealthy] = useState(false);
  useEffect(() => {
    if (health.lifecycle === 'healthy') setSeenHealthy(true);
  }, [health.lifecycle]);
  const message = statusMessage(
    health.lifecycle,
    health.transport,
    seenHealthy,
    hasConnectedAgentTransport(),
    health.reason,
  );
  if (!message) return null;
  const Icon = health.lifecycle === 'recovery-required' ? AlertTriangle : RefreshCw;
  const accent =
    health.lifecycle === 'recovery-required' ? 'text-droid-orange' : 'text-droid-accent';

  return (
    <div
      role="status"
      className="shrink-0 flex items-center gap-2 px-4 h-8 border-b border-droid-border bg-droid-elevated/60 text-[12px]"
    >
      <Icon className={`w-3.5 h-3.5 ${accent}`} />
      <span className="text-droid-text">{message}</span>
    </div>
  );
}

function statusMessage(
  lifecycle: ReturnType<typeof useRuntimeHealth>['lifecycle'],
  transport: ReturnType<typeof useRuntimeHealth>['transport'],
  seenHealthy: boolean,
  hasConnected: boolean,
  reason?: string,
): string | null {
  switch (lifecycle) {
    case 'restarting':
      return 'Agent runtime is restarting. History, files, and notes stay available.';
    case 'starting':
      return seenHealthy
        ? 'Agent runtime is restarting. History, files, and notes stay available.'
        : null;
    case 'recovery-required':
      return (
        reason ?? 'Agent runtime needs recovery. Restart DROIDEX if sending a message still fails.'
      );
    case 'stopped':
      return seenHealthy ? 'Agent runtime is stopped.' : null;
    case 'healthy':
    case 'degraded':
      return transport === 'disconnected' && hasConnected
        ? 'Reconnecting to the agent runtime…'
        : null;
  }
}
