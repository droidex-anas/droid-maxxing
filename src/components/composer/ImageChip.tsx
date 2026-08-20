import { useState } from 'react';
import { ImageOff, X } from 'lucide-react';

// Thumbnail chip for an image staged in the composer. Clicking the image opens
// the viewer; the corner badge removes it without opening anything. `src` is a
// data URL for a freshly pasted image and a droidex-img URL for one restored
// from a queued prompt, so both look identical in the composer. A restored file
// can have been swept from the temp store, hence the placeholder state.
export function ImageChip({
  src,
  label,
  onOpen,
  onRemove,
}: {
  src: string;
  label: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <span className="group relative shrink-0">
      <button
        onClick={failed ? undefined : onOpen}
        disabled={failed}
        className="block h-16 w-16 overflow-hidden rounded-lg border border-droid-border bg-droid-bg/60 transition-colors hover:border-droid-border-hover disabled:cursor-default"
        title={failed ? `${label} is no longer available` : `View ${label}`}
      >
        {failed ? (
          // Name the missing file in place: several restored chips can fail at
          // once, and an anonymous icon says nothing about which one is gone.
          <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-droid-text-muted">
            <ImageOff className="h-4 w-4 shrink-0" />
            <span className="max-w-full truncate text-[9px] leading-none">{label}</span>
          </span>
        ) : (
          <img
            src={src}
            alt={label}
            draggable={false}
            className="h-full w-full object-cover"
            onError={() => {
              setFailed(true);
            }}
          />
        )}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-droid-border bg-droid-elevated text-droid-text-muted shadow-sm transition-colors hover:border-droid-border-hover hover:text-droid-text"
        title="Remove image"
      >
        <X className="h-2.5 w-2.5" strokeWidth={3} />
      </button>
    </span>
  );
}
