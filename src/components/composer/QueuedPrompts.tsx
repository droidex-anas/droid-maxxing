import { useState } from 'react';
import {
  GripVertical,
  ImageOff,
  ListPlus,
  MousePointerSquareDashed,
  Pencil,
  X,
} from 'lucide-react';
import type { QueuedPrompt } from '../../hooks/useStore';
import { imageSrc, partitionImagePaths, pathBaseName } from '../../lib/localImage';
import { queuedPromptPreview } from './queuedPromptPreview';

// Queued attachments are a reminder, not a gallery: one tiny thumbnail stands in
// for the prompt's images and carries the total as a badge. Editing the prompt
// brings every image back as a full composer chip.
function QueuedImages({ paths }: { paths: string[] }) {
  const [failed, setFailed] = useState(false);
  const first = paths[0];
  const src = imageSrc(first);
  const label = paths.length === 1 ? pathBaseName(first) : `${String(paths.length)} images`;

  return (
    <span
      title={paths.map((p) => pathBaseName(p)).join('\n')}
      className="relative mt-1 inline-block h-6 w-6 align-middle"
    >
      {/* The badge overhangs the thumbnail, so the clipping box is the inner
          element: putting overflow-hidden on the positioned parent would cut it. */}
      <span className="block h-full w-full overflow-hidden rounded-md border border-droid-border bg-droid-bg/60">
        {src === null || failed ? (
          <span className="flex h-full w-full items-center justify-center text-droid-text-muted">
            <ImageOff className="h-3 w-3" />
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
      </span>
      {paths.length > 1 && (
        <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-droid-border bg-droid-elevated px-0.5 text-[8px] font-semibold leading-none text-droid-text">
          {paths.length}
        </span>
      )}
    </span>
  );
}

// Prompts staged while the model is busy; they send one at a time after the
// current turn. Rows are HTML5-draggable to reorder; the drag state lives here
// because nothing outside the list cares about an in-flight reorder.
export function QueuedPrompts({
  queue,
  onReorder,
  onEdit,
  onRemove,
}: {
  queue: QueuedPrompt[];
  onReorder: (from: number, to: number) => void;
  onEdit: (prompt: QueuedPrompt) => void;
  onRemove: (id: string) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  if (queue.length === 0) return null;

  const handleDrop = (to: number) => {
    if (dragIndex !== null && dragIndex !== to) onReorder(dragIndex, to);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium tracking-wide text-droid-text-muted">
        <ListPlus className="w-3 h-3" />
        Queued · sends after the current turn
      </div>
      {queue.map((p, i) => {
        const images = partitionImagePaths(p.files).images;
        return (
          <div
            key={p.id}
            draggable
            onDragStart={() => {
              setDragIndex(i);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverIndex(i);
            }}
            onDrop={() => {
              handleDrop(i);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setDragOverIndex(null);
            }}
            className={`group flex items-start gap-2 rounded-xl border bg-droid-elevated px-2 py-1.5 transition-colors ${
              dragOverIndex === i && dragIndex !== null && dragIndex !== i
                ? 'border-droid-orange'
                : 'border-droid-border'
            }`}
          >
            <span
              className="mt-0.5 cursor-grab text-droid-text-muted/60 active:cursor-grabbing"
              title="Drag to reorder"
            >
              <GripVertical className="w-3.5 h-3.5" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="line-clamp-2 block break-words text-[12px] text-droid-text-secondary">
                {queuedPromptPreview(p.text) || '(empty)'}
              </span>
              {images.length > 0 && <QueuedImages paths={images} />}
              {p.design && p.design.references.length > 0 && (
                <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-black/20 px-1.5 py-0.5 text-[10px] text-droid-text-muted">
                  <MousePointerSquareDashed className="w-3 h-3" />
                  {p.design.references.length} reference
                  {p.design.references.length === 1 ? '' : 's'}
                </span>
              )}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              {!p.design && (
                <button
                  onClick={() => {
                    onEdit(p);
                  }}
                  className="rounded p-1 text-droid-text-muted hover:text-droid-text hover:bg-black/20"
                  title="Edit in composer"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => {
                  onRemove(p.id);
                }}
                className="rounded p-1 text-droid-text-muted hover:text-droid-orange hover:bg-black/20"
                title="Delete"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
