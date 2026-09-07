import { useEffect, useRef, useState } from 'react';

// Streamed tokens arrive in uneven bursts; revealing a bounded number of
// characters per frame turns the bursts into a steady typing cadence. The step
// scales with the backlog so a huge burst still converges quickly, and the
// loop only runs while the revealed text is behind the source.
const MIN_CHARS_PER_FRAME = 3;
const MAX_CODE_POINTS_PER_FRAME = 64;
const CATCH_UP_FRACTION = 8;

export function nextRevealedText(latest: string, current: string): string {
  if (!latest.startsWith(current) || current.length >= latest.length) return latest;
  const backlog = latest.length - current.length;
  const step = Math.min(
    MAX_CODE_POINTS_PER_FRAME,
    Math.max(MIN_CHARS_PER_FRAME, Math.ceil(backlog / CATCH_UP_FRACTION)),
  );
  let index = current.length;
  let taken = 0;
  while (index < latest.length && taken < step) {
    const code = latest.charCodeAt(index);
    const next = index + 1 < latest.length ? latest.charCodeAt(index + 1) : 0;
    const paired = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    index += paired ? 2 : 1;
    taken += 1;
  }
  return latest.slice(0, index);
}

export function useSmoothStreamingText(source: string, live: boolean): string {
  const [shown, setShown] = useState(source);
  const shownRef = useRef(source);
  const sourceRef = useRef(source);
  const frameRef = useRef(0);

  useEffect(() => {
    sourceRef.current = source;
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
      const next = nextRevealedText(latest, current);
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
