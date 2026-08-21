import { X, type LucideIcon } from 'lucide-react';

const ACCENT = 'var(--droid-accent)';
const accentMix = (pct: number) =>
  `color-mix(in srgb, var(--droid-accent) ${String(pct)}%, transparent)`;

// The composer's accent chip for a selection the next prompt carries: a skill,
// or an invoked plugin such as Visualize. Attachments use their own neutral
// chips, so the accent reads as "this changes how the turn runs". A plugin
// brings its own icon; a skill is its name alone, since one shared glyph on
// every skill says nothing about which one is selected.
export function SelectionChip({
  icon: Icon,
  label,
  title,
  removeLabel,
  onRemove,
}: {
  icon?: LucideIcon;
  label: string;
  title?: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <span
      className="group flex items-center gap-1.5 rounded-lg py-1 pl-2 pr-1 text-[11px] font-medium"
      style={{
        background: accentMix(14),
        color: ACCENT,
        boxShadow: `inset 0 0 0 1px ${accentMix(35)}`,
      }}
      title={title}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {label}
      <button
        onClick={onRemove}
        className="rounded p-0.5 transition-colors hover:bg-black/20"
        title={removeLabel}
        aria-label={removeLabel}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
