// The Visualize plugin's mark in the brand icon language: a dark tinted
// squircle tile carrying one bright, fully filled glyph. Ascending bars say
// "your data, drawn", which is what a Visualize app is. Unlike the lucide
// outline icons it replaces, the tile owns its colours, so callers only set
// the box size through className.
export function VisualizeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="#3E0B4D" />
      <rect x="5.8" y="13" width="3.6" height="5.4" rx="1.8" fill="#D946EF" />
      <rect x="10.2" y="9.4" width="3.6" height="9" rx="1.8" fill="#D946EF" />
      <rect x="14.6" y="5.8" width="3.6" height="12.6" rx="1.8" fill="#D946EF" />
    </svg>
  );
}
