import { useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { X } from 'lucide-react';

const SKILL = 'var(--droid-skill)';

// gap-2 between selections, and the space between the last one and the first
// word of the draft.
const GAP_PX = 8;
const TRAILING_SPACE_PX = 8;
// Above this share of the line, an indent would leave too little room to type,
// so the selections take a line of their own instead.
const MAX_LINE_SHARE = 0.55;

export interface DraftSelection {
  key: string;
  // Sized through className by the row; the glyph itself may be a lucide
  // outline or a self-coloured brand tile like the Visualize mark.
  icon: ComponentType<{ className?: string }>;
  label: string;
  removeLabel: string;
  onRemove: () => void;
}

// The skills and plugins the next prompt carries, painted onto the first line of
// the draft: the caret sits right after them, typing continues from there, and
// Backspace on an empty draft takes the last one off whole.
//
// They cannot be textarea text, since a textarea gives its whole value one
// colour, so this row floats over the first line and reports the width that line
// must be indented by. Colour comes from --droid-skill, the blue the transcript
// gives an invoked skill, so a selection looks the same before and after it is
// sent.
export function DraftSelections({
  items,
  onWidthChange,
}: {
  items: readonly DraftSelection[];
  onWidthChange: (width: number) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [sharesFirstLine, setSharesFirstLine] = useState(true);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) {
      onWidthChange(0);
      return;
    }
    const measure = () => {
      const selections = Array.from(row.children, (child) =>
        child instanceof HTMLElement ? child.offsetWidth : 0,
      );
      const needed =
        selections.reduce((total, width) => total + width, 0) +
        GAP_PX * Math.max(0, selections.length - 1) +
        TRAILING_SPACE_PX;
      // Labels ellipsize at a fixed width, so a selection measures the same in
      // either layout and this choice cannot oscillate between them.
      const line = row.offsetParent instanceof HTMLElement ? row.offsetParent.clientWidth : 0;
      const fits = needed <= line * MAX_LINE_SHARE;
      setSharesFirstLine(fits);
      onWidthChange(fits ? needed : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    // The row for labels, the font size setting, and zoom; the line it sits on
    // because a narrower composer can stop the selections from fitting.
    observer.observe(row);
    if (row.offsetParent instanceof HTMLElement) observer.observe(row.offsetParent);
    return () => {
      observer.disconnect();
    };
  }, [items, onWidthChange]);

  if (items.length === 0) return null;
  return (
    <div
      ref={rowRef}
      // Sharing the line means floating over it: left-4/top-3 and the 20px line
      // box match the textarea's px-4 pt-3 and text-sm. Too wide for that, and
      // the selections become an ordinary row above the draft.
      className={
        sharesFirstLine
          ? 'pointer-events-none absolute left-4 top-3 z-10 flex h-5 items-center gap-2 text-sm font-medium leading-5'
          : 'flex flex-wrap items-center gap-2 px-4 pt-3 text-sm font-medium leading-5'
      }
      style={{ color: SKILL }}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          // Backspace removes the selection, and so does clicking it. The icon
          // becomes an ✕ under the pointer to say so, which keeps the removal
          // affordance out of the indent: anything that appeared on hover would
          // either widen the row or land on top of the draft text.
          <button
            key={item.key}
            onClick={item.onRemove}
            className="group pointer-events-auto flex min-w-0 items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
            title={item.removeLabel}
            aria-label={item.removeLabel}
          >
            <span className="relative h-4 w-4 shrink-0">
              <Icon className="h-4 w-4 transition-opacity group-hover:opacity-0" />
              <X className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
            </span>
            <span className="max-w-[16rem] truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
