import type { Transition } from 'framer-motion';

/**
 * Open motion shared by the two full-window image viewers — the transcript
 * lightbox and the composer's attachment viewer — so they read as the same
 * surface. Short expo fade; the content adds a small scale on top of it.
 *
 * Under reduced motion the scale is dropped and only the fade remains, which is
 * what the setting asks for: no movement, still a state change the eye can
 * follow.
 */
export const IMAGE_VIEWER_TRANSITION: Transition = {
  duration: 0.18,
  ease: [0.16, 1, 0.3, 1],
};

export function imageViewerContentMotion(reduceMotion: boolean | null) {
  return {
    initial: { opacity: 0, scale: reduceMotion ? 1 : 0.97 },
    animate: { opacity: 1, scale: 1 },
    transition: IMAGE_VIEWER_TRANSITION,
  };
}
