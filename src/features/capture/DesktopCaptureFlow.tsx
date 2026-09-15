import { useEffect, useRef } from 'react';
import { captureApi } from './types';
import { exportCapture, loadCaptureImage } from './render';
import { playCaptureClick } from './captureSound';
import { createCaptureGeneration } from './composerDestination';
import { toast } from '../../lib/toast';

export default function DesktopCaptureFlow({
  onAttach,
  onClose,
}: {
  onAttach: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const latest = useRef({ onAttach, onClose });
  latest.current = { onAttach, onClose };
  useEffect(() => {
    const lifetime = createCaptureGeneration();
    const stamp = lifetime.stamp();
    const requestId = crypto.randomUUID();
    const api = captureApi();
    // Deferring start lets StrictMode clean up its probe before any native IPC.
    void Promise.resolve()
      .then(async () => {
        if (!lifetime.isCurrent(stamp)) return;
        const computed = getComputedStyle(document.documentElement);
        const theme: Record<string, string> = {};
        for (const name of [
          'bg',
          'surface',
          'elevated',
          'border',
          'text',
          'text-secondary',
          'text-muted',
          'accent',
        ]) {
          const key = `--droid-${name}`;
          theme[key] = computed.getPropertyValue(key).trim();
        }
        const original = await api.take({ requestId, mode: 'desktop', theme });
        if (!lifetime.isCurrent(stamp) || !original) return;
        const image = await loadCaptureImage(original.source);
        if (!lifetime.isCurrent(stamp)) return;
        const output = await exportCapture(image, original.recipe);
        if (!lifetime.isCurrent(stamp)) return;
        await api.save(original.id, original.revision, original.recipe, output);
        if (!lifetime.isCurrent(stamp)) return;
        await latest.current.onAttach(original.id);
        if (!lifetime.isCurrent(stamp)) return;
        const status = await api.preferences();
        if (lifetime.isCurrent(stamp) && status.preferences.sound)
          void playCaptureClick().catch(() => undefined);
      })
      .catch((reason: unknown) => {
        if (lifetime.isCurrent(stamp))
          toast.error(reason instanceof Error ? reason.message : 'Desktop capture failed');
      })
      .finally(() => {
        if (lifetime.isCurrent(stamp)) latest.current.onClose();
      });
    return () => {
      lifetime.invalidate();
      void api.cancel(requestId).catch(() => undefined);
    };
  }, []);
  return null;
}
