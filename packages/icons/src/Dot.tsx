// The stroke keeps tiny dots visible at 14px alongside the line glyphs.
export function Dot({ cx, cy, r = 0.6 }: { cx: number; cy: number; r?: number }) {
  return <circle cx={cx} cy={cy} r={r} />;
}
