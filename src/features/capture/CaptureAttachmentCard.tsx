import { motion, useReducedMotion } from 'framer-motion';
import { Scan, X } from 'lucide-react';
import type { CaptureMetadata } from './types';

export function CaptureAttachmentCard({
  preview,
  capture,
  onOpen,
  onRemove,
}: {
  preview: string;
  capture: CaptureMetadata;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className="capture-attachment relative w-60 max-w-full overflow-hidden rounded-xl border border-droid-border bg-droid-surface"
      initial={reducedMotion ? false : { opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
    >
      <button
        type="button"
        className="block w-full p-2 text-left"
        onClick={onOpen}
        aria-label={'Edit screenshot: ' + capture.title}
      >
        <img
          src={preview}
          alt={capture.title}
          className="h-32 w-full rounded-lg bg-droid-bg object-contain"
        />
        <span className="flex items-center gap-2 px-1 pb-1 pt-2 text-xs text-droid-text">
          <Scan size={14} className="shrink-0" />
          <span className="truncate">{capture.title}</span>
        </span>
        <span className="block px-1 pb-1 text-[10px] text-droid-text-muted">
          {capture.width} × {capture.height} · PNG · Edit
        </span>
      </button>
      <button
        type="button"
        className="absolute right-3 top-3 grid place-items-center rounded-full border border-droid-border bg-droid-surface p-1 text-droid-text-secondary hover:text-droid-text"
        aria-label={'Remove ' + capture.title}
        onClick={onRemove}
      >
        <X size={13} />
      </button>
    </motion.div>
  );
}
