import { useEffect, useRef, useState } from 'react';

// Streamed tokens arrive in uneven bursts; revealing a bounded number of
// characters per frame turns the bursts into a steady typing cadence. The step
// scales with the backlog so a huge burst still converges quickly, and the
// loop only runs while the revealed text is behind the source.
const MIN_CHARS_PER_FRAME = 3;
const CATCH_UP_FRACTION = 8;

export function useSmoothStreamingText(source: string, live: boolean): string {
  const [shown, setShown] = useState(source);
  const shownRef = useRef(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const frameRef = useRef(0);

  useEffect(() => {
    if (!live || typeof requestAnimationFrame !== 'function') {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      shownRef.current = source;
      setShown(source);
      return;
    }
    // Replaced or rewound text cannot be revealed incrementally; snap to it.
    if (!source.startsWith(shownRef.current)) {
      shownRef.current = source;
      setShown(source);
      return;
    }
    if (frameRef.current || shownRef.current.length >= source.length) return;
    const tick = () => {
      frameRef.current = 0;
      const latest = sourceRef.current;
      const current = shownRef.current;
      if (!latest.startsWith(current)) {
        shownRef.current = latest;
        setShown(latest);
        return;
      }
      if (current.length >= latest.length) return;
      const backlog = latest.length - current.length;
      const step = Math.max(MIN_CHARS_PER_FRAME, Math.ceil(backlog / CATCH_UP_FRACTION));
      const next = latest.slice(0, current.length + step);
      shownRef.current = next;
      setShown(next);
      if (next.length < latest.length) frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [source, live]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return live ? shown : source;
}

// How long after the last streamed token the caret keeps blinking. The caret
// means "text is flowing", so an idle stream — including a wedged pending flag
// upstream — must not blink forever; fresh text restarts it.
const TYPING_IDLE_MS = 1600;

export function useStreamingActivity(text: string, active: boolean): boolean {
  const [typing, setTyping] = useState(active);

  useEffect(() => {
    if (!active) {
      setTyping(false);
      return;
    }
    setTyping(true);
    const timer = setTimeout(() => {
      setTyping(false);
    }, TYPING_IDLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, active]);

  return active && typing;
}
