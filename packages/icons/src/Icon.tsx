import type { FunctionComponent, ReactNode, SVGProps } from 'react';

// A 24px grid with optical padding and curved silhouettes for 14–24px UI use.
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'children'> {
  /** Width and height, defaulting to 24px. CSS dimensions take precedence. */
  size?: number | string;
}

export type IconComponent = FunctionComponent<IconProps>;

/* @__NO_SIDE_EFFECTS__ */
export function createIcon(
  name: string,
  glyph: ReactNode,
  defaultStrokeWidth = 1.5,
): IconComponent {
  function Icon({
    size = 24,
    strokeWidth = defaultStrokeWidth,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    ...rest
  }: IconProps) {
    const labelled = Boolean(ariaLabel) || Boolean(ariaLabelledBy);
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        role={labelled ? 'img' : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-hidden={labelled ? undefined : true}
        data-icon={name}
        {...rest}
      >
        {glyph}
      </svg>
    );
  }
  Icon.displayName = `Icon(${name})`;
  return Icon;
}
