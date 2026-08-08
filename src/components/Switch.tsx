interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Switch({ label, checked, onChange, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className={`flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 ring-1 ring-inset transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/60 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-droid-accent ring-droid-accent' : 'bg-droid-elevated ring-droid-border-hover'}`}
    >
      <span
        className={`h-5 w-5 rounded-full shadow-sm transition-[transform,background-color] duration-200 ${checked ? 'translate-x-4 bg-droid-bg' : 'translate-x-0 bg-droid-text-secondary'}`}
      />
    </button>
  );
}
