import { AlertTriangle, RefreshCw } from 'lucide-react';
import { createElement, useEffect, useState, type ComponentType } from 'react';

import { useHistoryHealth } from '../hooks/useHistoryHealth';
import { useRuntimeHealth } from '../hooks/useRuntimeHealth';
import { HISTORY_PERSISTENCE_DEGRADED_MESSAGE } from '../lib/historyStatusCopy';
import { hasConnectedAgentTransport } from '../lib/runtimeHealth';

export default function RuntimeStatusBanner() {
  const health = useRuntimeHealth();
  const history = useHistoryHealth();
  const [seenHealthy, setSeenHealthy] = useState(false);
  useEffect(() => {
    if (health.lifecycle === 'healthy') setSeenHealthy(true);
  }, [health.lifecycle]);
  const runtimeMessage = statusMessage(
    health.lifecycle,
    health.transport,
    seenHealthy,
    hasConnectedAgentTransport(),
    health.reason,
  );
  const persistenceDegraded = history.persistence === 'degraded';
  if (!runtimeMessage && !persistenceDegraded) return null;
  const runtimeIcon = health.lifecycle === 'recovery-required' ? AlertTriangle : RefreshCw;
  const runtimeAccent =
    health.lifecycle === 'recovery-required' ? 'text-droid-orange' : 'text-droid-accent';

  return (
    <>
      {runtimeMessage ? (
        <StatusBannerRow icon={runtimeIcon} accent={runtimeAccent} message={runtimeMessage} />
      ) : null}
      {persistenceDegraded ? (
        <StatusBannerRow
          icon={AlertTriangle}
          accent="text-droid-orange"
          message={HISTORY_PERSISTENCE_DEGRADED_MESSAGE}
          testId="history-persistence-banner"
        />
      ) : null}
    </>
  );
}

function StatusBannerRow({
  icon,
  accent,
  message,
  testId,
}: {
  icon: ComponentType<{ className?: string }>;
  accent: string;
  message: string;
  testId?: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="shrink-0 flex items-center gap-2 px-4 h-8 border-b border-droid-border bg-droid-elevated/60 text-[12px]"
    >
      {createElement(icon, { className: `w-3.5 h-3.5 ${accent}` })}
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
