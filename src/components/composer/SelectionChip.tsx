import { X, type LucideIcon } from 'lucide-react';

const SKILL = 'var(--droid-skill)';

// A selection the next prompt carries: a skill, or an invoked plugin such as
// Visualize. It reads in --droid-skill, the same blue the transcript gives an
// invoked skill, so a selection looks the same before and after it is sent, and
// it stays blue in every theme instead of following the accent (which is a
// near-white neutral in most of them).
//
// Attachments keep their own neutral chips: those add material to the prompt,
// while this changes how the turn runs.
export function SelectionChip({
  icon: Icon,
  label,
  title,
  removeLabel,
  onRemove,
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <span
      className="group flex items-center gap-1.5 text-sm font-medium"
      style={{ color: SKILL }}
      title={title}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
      {/* Backspace on an empty draft removes the chip; this is the same for the
          mouse, kept quiet until the chip is hovered so the resting composer
          shows the selection and nothing else. */}
      <button
        onClick={onRemove}
        className="rounded p-0.5 text-droid-text-muted opacity-0 transition-opacity hover:text-droid-text group-hover:opacity-100 focus:opacity-100 focus:outline-none"
        title={removeLabel}
        aria-label={removeLabel}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
