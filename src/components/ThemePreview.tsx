// Theme visualizations for the Appearance settings: a miniature app wireframe
// and the icon-sized theme glyphs. Everything paints with explicit palette
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

/**
 * The theme's palette as a small app-icon glyph: the MiniAppFrame wireframe
 * (sidebar, chat lines, input bar with an accent send dot) rendered at icon
 * size in a rounded square. Pure CSS, so it stays crisp at any size, and it
 * shows how the palette actually distributes across the app instead of
 * abstracting it into a shape.
 */
export function ThemeSwatches({
  preset,
  scheme,
  size = 44,
}: {
  preset: ThemePreset;
  scheme: 'light' | 'dark';
  size?: number;
}) {
  const colors = preset[scheme];
  // A soft aura in the theme accent supplies the glow; the glyph edge itself
  // stays sharp so the colors read clearly at small sizes.
  const aura = `0 0 ${Math.max(6, Math.round(size / 2.5))}px ${colors.accent}59`;
  // MiniAppFrame is laid out with fixed px details, so paint it at a design
  // size and scale the box down — the wireframe keeps its proportions instead
  // of collapsing at icon size, and pure CSS stays crisp at any scale.
  const designSize = 120;
  return (
    <span
      className="block overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(8, Math.round(size * 0.24)),
        boxShadow: `inset 0 0 0 1px ${colors.border}, ${aura}`,
      }}
    >
      <span
        className="block"
        style={{
          width: designSize,
          height: designSize,
          transform: `scale(${size / designSize})`,
          transformOrigin: 'top left',
        }}
      >
        <MiniAppFrame colors={colors} />
      </span>
    </span>
  );
}
