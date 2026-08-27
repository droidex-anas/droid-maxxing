import { useEffect, useRef } from 'react';

import { useDocumentVisible } from './useDocumentVisible';
import { useStoreDispatch, useStoreSelector } from './useStore';
import { setBackgroundWork } from '../lib/commands';
import { resolveBackgroundWorkTier, type BackgroundWorkTier } from '../lib/backgroundWork';
import { desktopPowerTier, onDesktopMemoryPressure, onDesktopPowerTier } from '../lib/desktop';

export function useBackgroundWorkTier(): BackgroundWorkTier {
  const documentVisible = useDocumentVisible();
  const focusedAppSessionId = useStoreSelector((state) => state.activeAppSessionId);
  const connected = useStoreSelector((state) => state.connection === 'connected');
  const dispatch = useStoreDispatch();
  const lastSent = useRef<{ tier: BackgroundWorkTier; focused: string | null } | null>(null);

  useEffect(() => {
    if (!connected) {
      lastSent.current = null;
      return;
    }
    let disposed = false;
    let windowVisible = true;
    let onBattery = false;

    const publish = (tier: BackgroundWorkTier) => {
      const focused = focusedAppSessionId;
      if (lastSent.current?.tier === tier && lastSent.current.focused === focused) return;
      lastSent.current = { tier, focused };
      setBackgroundWork(tier, focused);
    };

    const sync = () => {
      if (disposed) return;
      publish(resolveBackgroundWorkTier({ windowVisible, documentVisible, onBattery }));
    };

    void desktopPowerTier().then((snapshot) => {
      if (disposed || !snapshot) return;
      windowVisible = snapshot.windowVisible;
      onBattery = snapshot.onBattery;
      sync();
    });

    const stopPower = onDesktopPowerTier((snapshot) => {
      windowVisible = snapshot.windowVisible;
      onBattery = snapshot.onBattery;
      sync();
    });
    const stopPressure = onDesktopMemoryPressure(() => {
      dispatch({ type: 'MEMORY_PRESSURE' });
    });
    sync();

    return () => {
      disposed = true;
      stopPower();
      stopPressure();
    };
  }, [connected, dispatch, documentVisible, focusedAppSessionId]);

  return resolveBackgroundWorkTier({ documentVisible });
}
