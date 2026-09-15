import { memo, useMemo } from 'react';
import { PanelRight } from '@droidex/icons';
import { ClampedReveal } from './ClampedReveal';
import { SpecRenderer } from './SpecRenderer';

// The pinned spec peek at the head of the chat: the document itself leads,
// clamped to a few lines behind the same fade + Show more affordance as a long
// prompt. 15px spec text at 1.8 leading = 27px per rendered line; the clamp
// shows the title plus four body lines.
const PREVIEW_LINE_PX = 27;
const PREVIEW_CLAMP_PX = PREVIEW_LINE_PX * 6;

export const SpecPreviewCard = memo(function SpecPreviewCard({
  content,
  onOpenReader,
}: {
  content: string;
  onOpenReader?: () => void;
}) {
  const sections = useMemo(() => (content.match(/^#{1,3}\s+/gm) ?? []).length, [content]);

  return (
    <div className="overflow-hidden rounded-2xl border border-droid-border bg-droid-elevated">
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-widest text-droid-text-muted/70">
          Spec
        </span>
        {sections > 0 && (
          <>
            <span className="text-[11px] text-droid-text-muted/40" aria-hidden>
              ·
            </span>
            <span className="text-[11px] tabular-nums text-droid-text-muted/50">
              {sections} {sections === 1 ? 'section' : 'sections'}
            </span>
          </>
        )}
        <div className="flex-1" />
        {onOpenReader && (
          <button
            type="button"
            onClick={onOpenReader}
            title="Open in reader"
            aria-label="Open spec in reader"
            className="rounded-md p-1 text-droid-text-muted/70 transition-colors hover:bg-droid-surface hover:text-droid-text"
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="px-4 pb-3.5">
        <ClampedReveal
          clampPx={PREVIEW_CLAMP_PX}
          linePx={PREVIEW_LINE_PX}
          fadeClassName="from-droid-elevated via-droid-elevated/90"
        >
          <SpecRenderer content={content} />
        </ClampedReveal>
      </div>
    </div>
  );
});
