// The Changes glyph: a plus over a dash inside a squircle, the shape Codex
// draws for the diff summary row.
export function ChangesIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="4.5" y="4.5" width="15" height="15" rx="4.5" />
      <path d="M12 8.4v4.2" />
      <path d="M9.9 10.5h4.2" />
      <path d="M9.9 15.4h4.2" />
    </svg>
  );
}
