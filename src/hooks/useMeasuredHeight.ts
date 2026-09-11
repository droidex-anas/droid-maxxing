import { useLayoutEffect, useState, type RefObject } from 'react';

// The element's border-box height, kept current as it grows or shrinks (a
// banner stack gaining a row), so dependent layout can follow it without a
// hardcoded size.
export function useMeasuredHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setHeight(element.offsetHeight);
    const observer = new ResizeObserver(() => {
      setHeight(element.offsetHeight);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return height;
}
