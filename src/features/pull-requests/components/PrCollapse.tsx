import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

// The fold affordance that goes with PrCollapse: one chevron, one rotation.
export function FoldChevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      aria-hidden="true"
      className={`h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-transform duration-200 ease-out group-hover:text-droid-text-secondary motion-reduce:transition-none ${
        open ? '' : '-rotate-90'
      }`}
    />
  );
}

// One owner of fold motion for the whole workspace: sections, commit groups,
// and comment cards all animate the same way.
//
// The panel animates `grid-template-rows` from 0fr to 1fr, which lets the
// browser size the row from the content instead of us measuring a pixel height.
// That is what keeps the fold from jumping on the first frame or overshooting
// when the content reflows (markdown, images, diff hunks) mid-transition.
// Content stays unmounted until the first expand, so a collapsed workspace
// never pays for what it does not show.
export function PrCollapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      }`}
    >
      {/* The row can only shrink below its content when the child both hides
          overflow and allows a zero minimum height. */}
      <div
        inert={!open}
        className={`min-h-0 overflow-hidden transition-opacity duration-150 ease-out motion-reduce:transition-none ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {mounted ? children : null}
      </div>
    </div>
  );
}
