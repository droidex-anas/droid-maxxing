// Theme visualizations for the Appearance settings: a miniature app wireframe
// and the dual-sphere theme swatches. Everything paints with explicit palette
// colors (never the live CSS variables) so cards can preview themes and schemes
// that are not currently applied.

import type { ThemeColors, ThemePreset } from '../lib/theme';

function Line({ colors, w, strong = false }: { colors: ThemeColors; w: string; strong?: boolean }) {
  return (
    <div
      className="h-[5px] rounded-full"
      style={{
        width: w,
        backgroundColor: colors.fg,
        opacity: strong ? 0.72 : 0.28,
      }}
    />
  );
}

/** Miniature Droid Control window (sidebar + chat + input) in a given palette. */
export function MiniAppFrame({ colors }: { colors: ThemeColors }) {
  return (
    <div
      className="flex h-full w-full overflow-hidden"
      style={{ backgroundColor: colors.bg, color: colors.fg }}
    >
      {/* Sidebar */}
      <div
        className="flex w-[26%] shrink-0 flex-col gap-[6px] p-[8px]"
        style={{ backgroundColor: colors.surface, borderRight: `1px solid ${colors.border}` }}
      >
        <div
          className="h-[6px] w-3/5 rounded-full"
          style={{ backgroundColor: colors.fg, opacity: 0.5 }}
        />
        <div className="mt-[2px] flex flex-col gap-[5px]">
          <Line colors={colors} w="85%" />
          <Line colors={colors} w="70%" />
          <Line colors={colors} w="78%" />
        </div>
      </div>

      {/* Main column */}
      <div className="relative flex min-w-0 flex-1 flex-col p-[8px]">
        <div className="flex flex-col gap-[6px]">
          <Line colors={colors} w="55%" strong />
          <Line colors={colors} w="80%" />
          <Line colors={colors} w="64%" />
        </div>
        {/* Reply card */}
        <div
          className="mt-[8px] flex flex-col gap-[5px] rounded-[6px] p-[7px]"
          style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}` }}
        >
          <Line colors={colors} w="48%" strong />
          <Line colors={colors} w="88%" />
          <Line colors={colors} w="58%" />
        </div>
        {/* Input bar */}
        <div
          className="mt-auto flex items-center rounded-[6px] px-[7px] py-[5px]"
          style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}` }}
        >
          <Line colors={colors} w="45%" />
          <span
            className="ml-auto h-[8px] w-[8px] shrink-0 rounded-full"
            style={{ backgroundColor: colors.accent }}
          />
        </div>
      </div>
    </div>
  );
}

/** Card preview for one color scheme; `system` splits light and dark halves. */
export function SchemePreview({
  preset,
  scheme,
}: {
  preset: ThemePreset;
  scheme: 'light' | 'dark' | 'system';
}) {
  if (scheme !== 'system') {
    return (
      <div className="h-full w-full overflow-hidden">
        <MiniAppFrame colors={preset[scheme]} />
      </div>
    );
  }
  // Two clipped copies of the same wireframe: light on the left, dark right.
  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="absolute inset-y-0 left-0 w-1/2 overflow-hidden">
        <div className="h-full w-[200%]">
          <MiniAppFrame colors={preset.light} />
        </div>
      </div>
      <div className="absolute inset-y-0 right-0 w-1/2 overflow-hidden">
        <div className="relative h-full w-[200%]" style={{ left: '-100%' }}>
          <MiniAppFrame colors={preset.dark} />
        </div>
      </div>
    </div>
  );
}

function sphereBackground(colors: ThemeColors): string {
  // Aurora orb: a crisp-edged sphere lit from inside — a pale surface sheen on
  // the upper left, the theme accent blooming from the lower right, over the
  // deep canvas. No blur filter on purpose: blurring smeared the stops into a
  // muddy blob and made color edits invisible.
  return [
    `radial-gradient(80% 80% at 30% 25%, ${colors.surface} 0%, transparent 55%)`,
    `radial-gradient(95% 95% at 68% 70%, ${colors.accent} 12%, transparent 70%)`,
    colors.bg,
  ].join(', ');
}

/** The two variant spheres of a theme (light left, dark right). */
export function ThemeSwatches({
  preset,
  activeScheme,
  size = 40,
}: {
  preset: ThemePreset;
  activeScheme?: 'light' | 'dark';
  size?: number;
}) {
  const sphere = (scheme: 'light' | 'dark') => {
    const colors = preset[scheme];
    const active = activeScheme === scheme;
    // A soft aura in the theme accent supplies the glow; the orb edge itself
    // stays sharp so the colors read clearly at small sizes.
    const aura = `0 0 ${Math.max(6, Math.round(size / 2.5))}px ${colors.accent}59`;
    return (
      <span
        className="rounded-full transition-shadow"
        style={{
          width: size,
          height: size,
          background: sphereBackground(colors),
          boxShadow: active
            ? `inset 0 0 0 1px ${colors.border}, ${aura}, 0 0 0 2px var(--droid-bg), 0 0 0 4px var(--droid-accent)`
            : `inset 0 0 0 1px ${colors.border}, ${aura}`,
        }}
      />
    );
  };
  return (
    <span className="flex items-center" style={{ gap: size * 0.45 }}>
      {sphere('light')}
      {sphere('dark')}
    </span>
  );
}
