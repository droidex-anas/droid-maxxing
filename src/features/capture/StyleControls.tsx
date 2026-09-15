import type { CaptureStyle } from './types';
import { BACKGROUNDS, backgroundFor } from './presets';

export function StyleControls({
  value,
  onChange,
  disabled = false,
}: {
  value: CaptureStyle;
  onChange: (style: CaptureStyle) => void;
  disabled?: boolean;
}) {
  const colors = value.colors ?? backgroundFor(value.preset).colors;
  return (
    <fieldset disabled={disabled} className="capture-style-controls">
      <legend className="capture-section-label">Background</legend>
      <div className="capture-swatches">
        {BACKGROUNDS.map((preset) => (
          <button
            type="button"
            key={preset.id}
            aria-pressed={value.preset === preset.id}
            onClick={() => {
              onChange({ ...value, preset: preset.id, colors: undefined });
            }}
            className="capture-preset"
          >
            <span style={{ background: preset.swatch }} />
            <span>{preset.name}</span>
          </button>
        ))}
      </div>
      <div className="capture-colors">
        {colors.map((color, index) => (
          <label key={index}>
            Color {index + 1}
            <input
              type="color"
              aria-label={'Gradient color ' + String(index + 1)}
              value={color}
              disabled={value.preset === 'transparent'}
              onChange={(event) => {
                const next: [string, string, string] = [...colors];
                next[index] = event.target.value;
                onChange({ ...value, colors: next });
              }}
            />
          </label>
        ))}
      </div>
      {(
        [
          ['padding', 'Breathing room', 240, 1],
          ['radius', 'Corners', 100, 1],
          ['shadow', 'Shadow', 100, 1],
          ['texture', 'Texture', 0.5, 0.01],
        ] as const
      ).map(([key, label, max, step]) => (
        <label key={key} className="capture-slider">
          <span>
            {label}
            <output>
              {key === 'texture'
                ? `${String(Math.round(value[key] * 100))}%`
                : `${String(value[key])}${key === 'padding' || key === 'radius' ? ' px' : ''}`}
            </output>
          </span>
          <input
            type="range"
            aria-label={label}
            min={0}
            max={max}
            step={step}
            value={value[key]}
            onChange={(event) => {
              onChange({ ...value, [key]: Number(event.target.value) });
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}
