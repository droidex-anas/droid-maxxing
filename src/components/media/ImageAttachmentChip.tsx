import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { imageSrc, pathBaseName } from '../../lib/localImage';
import { ImageLightbox } from './ImageLightbox';

/**
 * Thumbnail chip for an image attached to a sent message. Mirrors the composer's
 * ImageChip so a pasted image looks the same before and after sending; clicking
 * it opens the full view. Attachments live in a temp store swept after a day, so
 * a chip whose file is gone shows as a named placeholder rather than vanishing.
 */
export function ImageAttachmentChip({ path }: { path: string }) {
  const src = imageSrc(path);
  // Keyed by src, not a flag: a chip at the same position can be handed a
  // different attachment, and a stale failure would hide a loadable one.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc !== null && failedSrc === src;
  const [open, setOpen] = useState(false);
  const label = pathBaseName(path) || path;

  if (src === null || failed) {
    return (
      <span
        title={path}
        className="flex items-center gap-1 rounded-lg border border-droid-border bg-droid-elevated/80 px-2 py-1 text-[11px] text-droid-text-muted"
      >
        <ImageOff className="h-3 w-3 shrink-0" />
        <span className="max-w-40 truncate">{label}</span>
      </span>
    );
  }

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
        }}
        title={`View ${label}`}
        className="block h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-droid-border bg-droid-bg/60 transition-colors hover:border-droid-border-hover"
      >
        <img
          src={src}
          alt={label}
          draggable={false}
          className="h-full w-full object-cover"
          onError={() => {
            setFailedSrc(src);
          }}
        />
      </button>
      {open && (
        <ImageLightbox
          src={src}
          label={path}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
