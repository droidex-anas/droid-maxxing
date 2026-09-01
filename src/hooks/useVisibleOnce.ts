import { useEffect, useState, type RefObject } from 'react';

// One-shot: start work when the node is near the viewport, then disconnect.
export function useVisibleOnce(ref: RefObject<Element | null>, rootMargin = '120px'): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver !== 'function') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [ref, rootMargin, visible]);
  return visible;
}
