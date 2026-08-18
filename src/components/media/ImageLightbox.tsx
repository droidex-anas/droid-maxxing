import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

/**
 * Read-only full-view for a single image: click a transcript thumbnail to
 * inspect it, Escape or a backdrop click to leave. The composer's
 * ImageViewerModal stays separate because it owns cropping of a staged
 * attachment; this one only displays.
 */
export function ImageLightbox({
  src,
  label,
  onClose,
}: {
  src: string;
  label: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  return (
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image: ${label}`}
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12 }}
      className="fixed inset-0 z-[1200] flex flex-col bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex flex-1 items-center justify-center overflow-hidden p-8">
        <motion.img
          src={src}
          alt={label}
          draggable={false}
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          className="block max-h-[80vh] max-w-[90vw] select-none rounded-lg border border-droid-border object-contain"
          onClick={(e) => {
            e.stopPropagation();
          }}
        />
      </div>
      <div className="flex items-center gap-3 border-t border-droid-border/60 bg-droid-bg/80 px-5 py-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-droid-text-muted">
          {label}
        </span>
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <X className="h-3.5 w-3.5" /> Close
        </button>
      </div>
    </motion.div>
  );
}
