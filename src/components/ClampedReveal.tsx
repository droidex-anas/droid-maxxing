import { useEffect, useRef, useState, type ReactNode } from 'react';

function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      className={`h-3 w-3 transition-transform duration-200 ${up ? 'rotate-180' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

// A content box capped at `clampPx` with a gradient fade and a Show more pill,
// shared by the long-prompt bubble and the inline spec preview. The cap lives
// on the outer box so the inner box always reports the real content height,
// including when an image or diagram settles later; the observer hands over a
// height the browser has already laid out, so mounting many clamps never
// forces a synchronous layout for each one.
export function ClampedReveal({
  clampPx,
  linePx,
  fadeClassName,
  children,
}: {
  clampPx: number;
  // Height of one rendered line; gives a line of slack so content that only
  // just overflows shows in full rather than hiding one line behind a control.
  linePx: number;
  // Gradient over the clamped tail; must start from the surrounding surface.
  fadeClassName: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(([entry]) => {
      setContentHeight(Math.ceil(entry.contentRect.height));
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Capped until measured, so long content is short from its first paint
  // instead of drawn at full height and then collapsed. `flow-root` keeps the
  // last child's margin inside the measured height: a reading even a pixel
  // short would slice the final line once expanded.
  const clamped = contentHeight !== null && contentHeight > clampPx + linePx;
  let maxHeight: number | undefined;
  if (contentHeight === null) maxHeight = clampPx;
  else if (clamped) maxHeight = expanded ? contentHeight : clampPx;

  const toggle = (
    <button
      onClick={() => {
        setExpanded((e) => !e);
      }}
      aria-expanded={expanded}
      className="flex items-center gap-1 rounded-full border border-droid-border bg-droid-surface px-2.5 py-1 text-[11px] font-medium text-droid-text-secondary shadow-sm transition-colors hover:border-droid-border-hover hover:text-droid-text"
    >
      {expanded ? 'Show less' : 'Show more'}
      <Chevron up={expanded} />
    </button>
  );

  return (
    <div className="relative w-full min-w-0">
      <div
        className="overflow-hidden transition-[max-height] duration-300 ease-out motion-reduce:transition-none"
        style={maxHeight === undefined ? undefined : { maxHeight }}
      >
        <div ref={contentRef} className="flow-root">
          {children}
        </div>
      </div>
      {clamped && !expanded && (
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t to-transparent ${fadeClassName}`}
        >
          <div className="pointer-events-auto">{toggle}</div>
        </div>
      )}
      {clamped && expanded && <div className="mt-2 flex justify-center">{toggle}</div>}
    </div>
  );
}
