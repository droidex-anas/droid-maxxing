import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { imageSrc, pathBaseName } from '../../lib/localImage';
import { ImageLightbox } from './ImageLightbox';

/**
 * An image inside a message body. Rendered as a bounded preview so a retina
 * screenshot cannot blow out the transcript, and clickable to inspect full size.
 * A reference we cannot load (relative path, deleted attachment, unsupported
 * type) degrades to a compact row naming it instead of a broken-image glyph.
 */
export function TranscriptImage({
  reference,
  alt,
  title,
}: {
  reference: string;
  alt?: string;
  title?: string;
}) {
  const src = imageSrc(reference);
  // Keyed by src rather than a plain flag: markdown reuses this node position for
  // whatever image the next render puts there, and a stale failure would hide a
  // perfectly loadable replacement.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc !== null && failedSrc === src;
  const [open, setOpen] = useState(false);
  // Markdown images frequently carry an empty alt, so fall back to the file name.
  const altLabel = alt?.trim() ?? '';
  const label = altLabel.length > 0 ? altLabel : pathBaseName(reference);

  if (src === null || failed) {
    return (
      <span
        title={title ?? reference}
        className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-droid-border bg-droid-elevated/50 px-2 py-1 text-[11.5px] text-droid-text-muted"
      >
        <ImageOff className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  return (
    <>
      <button
        onClick={(e) => {
          // Markdown can wrap an image in a link, which puts this control inside
          // an anchor; without this the click would also follow the link.
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        title={title ?? `View ${label}`}
        className="my-1.5 block max-w-full overflow-hidden rounded-xl border border-droid-border bg-droid-bg/40 transition-colors hover:border-droid-border-hover"
      >
        <img
          src={src}
          alt={label}
          draggable={false}
          className="block max-h-64 max-w-full object-contain"
          onError={() => {
            setFailedSrc(src);
          }}
        />
      </button>
      {open && (
        <ImageLightbox
          src={src}
          label={label}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
