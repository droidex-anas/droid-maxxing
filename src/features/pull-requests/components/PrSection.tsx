import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import { PrCollapse } from './PrCollapse';

// Every long stretch of a pull request (description, checks, conflicts,
// activity) folds from its own header, so a 200-line description never buries
// the conversation. Fold state is local: it resets when the workspace rebuilds
// the sections for another pull request.
export function PrSection({
  title,
  count,
  meta,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mt-7 first:mt-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="group -ml-1 flex min-w-0 items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-droid-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/50"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-transform duration-200 ease-out group-hover:text-droid-text-secondary motion-reduce:transition-none ${
              open ? '' : '-rotate-90'
            }`}
          />
          <span className="truncate text-[13px] font-semibold text-droid-text">{title}</span>
          {count != null ? (
            <span className="rounded-full bg-droid-elevated px-1.5 py-0.5 text-[11px] tabular-nums text-droid-text-secondary">
              {count}
            </span>
          ) : null}
        </button>
        {meta ? <div className="ml-auto flex min-w-0 items-center gap-2">{meta}</div> : null}
      </div>
      {/* The spacing lives inside the folding panel so a closed section takes
          exactly the height of its header. */}
      <PrCollapse open={open}>
        <div className="pt-2.5">{children}</div>
      </PrCollapse>
    </section>
  );
}
