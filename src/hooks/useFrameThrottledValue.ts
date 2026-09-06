import { useEffect, useRef, useState } from 'react';

// Token-rate values (child previews, streaming markdown) paint at most once
// per animation frame so a burst cannot schedule a re-render per character.
export function useFrameThrottledValue<T>(value: T, enabled: boolean): T {
  const [shown, setShown] = useState(value);
  const pendingRef = useRef(value);
  const frameRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      setShown(value);
      return;
    }
    pendingRef.current = value;
    if (frameRef.current) return;
    if (typeof requestAnimationFrame !== 'function') {
      setShown(value);
      return;
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setShown(pendingRef.current);
    });
  }, [enabled, value]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return enabled ? shown : value;
}
