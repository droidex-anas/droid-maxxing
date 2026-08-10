export function WorktreeIcon({ className }: { className?: string }) {
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
      <path d="M4 12h3l9-9" />
      <path d="M11 3h5v5" />
      <path d="m7 12 9 9" />
      <path d="M11 21h5v-5" />
    </svg>
  );
}
