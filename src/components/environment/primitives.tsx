// Shared Context-panel primitives used by RightPanel and the environment/VCS
// components so the rows, headers, and dividers stay visually identical.
//
// The panel speaks one row language: a 16px icon, a 13px label, and an
// optional meta pill or trailing affordance. Numbers always render in
// tabular figures (never a monospace face) so counts align without the UI
// slipping into code typography.
import type { AriaAttributes, ReactNode, Ref } from 'react';

export function SectionHeader({ label, trailing }: { label: string; trailing?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-3 pb-1 pt-4">
      <span className="text-[12px] font-medium text-droid-text-muted">{label}</span>
      {trailing && (
        <span className="shrink-0 text-[11px] leading-none text-droid-text-muted">{trailing}</span>
      )}
    </div>
  );
}

export function Divider() {
  return <div className="mx-3 my-1 h-px bg-droid-border/60" />;
}

export function Row({
  ref,
  icon,
  label,
  meta,
  onClick,
  active,
  expanded,
  hasPopup,
  trailing,
  title,
  disabled,
}: {
  ref?: Ref<HTMLButtonElement>;
  icon: ReactNode;
  label: ReactNode;
  meta?: string;
  onClick?: () => void;
  active?: boolean;
  // Popover triggers report their state to assistive technology; plain rows
  // leave both undefined.
  expanded?: boolean;
  hasPopup?: AriaAttributes['aria-haspopup'];
  trailing?: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  const content = (
    <>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-droid-text-muted transition-colors group-hover:text-droid-text-secondary">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-droid-text">
        {label}
      </span>
      {meta && (
        <span className="shrink-0 rounded-md bg-droid-elevated px-1.5 py-0.5 text-[11px] font-medium capitalize leading-none text-droid-text-secondary tabular-nums">
          {meta}
        </span>
      )}
      {trailing}
    </>
  );
  // A row without an action is a readout (the model line), not a control:
  // render plain markup rather than a focusable button that does nothing.
  if (!onClick) {
    return (
      <div
        title={title}
        className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left"
      >
        {content}
      </div>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-expanded={expanded}
      aria-haspopup={hasPopup}
      className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-default ${
        active ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
      }`}
    >
      {content}
    </button>
  );
}

// The disclosure caret that expandable rows (branch, worktree, changes) carry
// on their trailing edge, so every fold rotates and dims identically.
export function RowCaret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3 w-3 shrink-0 text-droid-text-muted/60 transition-transform duration-150 ${
        open ? 'rotate-180' : ''
      }`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}
