const ACCENT = 'var(--droid-accent)';

export function StreamingCaret() {
  return (
    <span
      className="caret-blink inline-block w-[2px] h-[1.05em] -mb-[0.15em] ml-0.5 rounded-sm align-baseline"
      style={{ background: ACCENT }}
    />
  );
}
