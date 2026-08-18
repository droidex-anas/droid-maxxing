// Entry/exit motion shared by the inline request cards above the composer
// (permission, ask-user, plan approval) so they behave as one family.
//
// Under prefers-reduced-motion the cards must not move or scale at all: a zero
// duration alone still commits Chromium to the transformed keyframes, so the
// reduced variant drops the transforms and keeps only an instant opacity swap.

const EASE = [0.16, 1, 0.3, 1] as const;
const DURATION_S = 0.22;

export interface InlineCardMotion {
  initial: { opacity: number; y?: number; scale?: number };
  animate: { opacity: number; y?: number; scale?: number };
  exit: { opacity: number; y?: number; scale?: number };
  transition: { duration: number; ease?: typeof EASE };
}

/** Motion props for an inline request card. Pass framer-motion's useReducedMotion(). */
export function inlineCardMotion(reduceMotion: boolean | null): InlineCardMotion {
  if (reduceMotion) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: 0 },
    };
  }
  return {
    initial: { opacity: 0, y: 8, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 8, scale: 0.985 },
    transition: { duration: DURATION_S, ease: EASE },
  };
}
