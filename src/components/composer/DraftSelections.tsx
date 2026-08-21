import { useLayoutEffect, useRef } from 'react';
import { X, type LucideIcon } from 'lucide-react';

const SKILL = 'var(--droid-skill)';

export interface DraftSelection {
  key: string;
  icon: LucideIcon;
  label: string;
  removeLabel: string;
  onRemove: () => void;
}

// The skills and plugins the next prompt carries, painted into the first line of
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
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) {
      onWidthChange(0);
      return;
    }
    const report = () => {
      onWidthChange(row.offsetWidth);
    };
    report();
    // Labels, the UI font size setting, and zoom all move this width.
    const observer = new ResizeObserver(report);
    observer.observe(row);
    return () => {
      observer.disconnect();
    };
  }, [items, onWidthChange]);

  if (items.length === 0) return null;
  return (
    <div
      ref={ref}
      // left-4/top-3 and the 20px line box match the textarea's px-4 pt-3 and
      // text-sm, so a selection sits on the draft's own first line.
      className="pointer-events-none absolute left-4 top-3 z-10 flex h-5 items-center gap-2 pr-2 text-sm font-medium leading-5"
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
            className="group pointer-events-auto flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
            title={item.removeLabel}
            aria-label={item.removeLabel}
          >
            <span className="relative h-4 w-4 shrink-0">
              <Icon className="h-4 w-4 transition-opacity group-hover:opacity-0" />
              <X className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
            </span>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
