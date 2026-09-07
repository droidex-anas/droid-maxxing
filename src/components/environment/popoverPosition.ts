export interface PopoverPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function calculatePopoverPosition({
  anchor,
  viewport,
  width,
  align,
}: {
  anchor: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width'>;
  viewport: { width: number; height: number };
  width: number | 'anchor';
  align: 'left' | 'right';
}): PopoverPosition {
  const margin = 8;
  const offset = 4;
  const requestedWidth = width === 'anchor' ? anchor.width : width;
  const resolvedWidth = Math.min(requestedWidth, Math.max(0, viewport.width - margin * 2));
  const rawLeft = align === 'right' ? anchor.right - resolvedWidth : anchor.left;
  const left = Math.min(
    Math.max(margin, rawLeft),
    Math.max(margin, viewport.width - resolvedWidth - margin),
  );
  const spaceBelow = viewport.height - anchor.bottom - margin;
  const spaceAbove = anchor.top - margin;
  if (spaceBelow < 240 && spaceAbove > spaceBelow) {
    const bottom = Math.max(
      margin,
      Math.min(viewport.height - margin, viewport.height - anchor.top + offset),
    );
    return {
      bottom,
      left,
      width: resolvedWidth,
      maxHeight: Math.max(0, viewport.height - bottom - margin),
    };
  }
  const top = Math.max(margin, Math.min(viewport.height - margin, anchor.bottom + offset));
  return {
    top,
    left,
    width: resolvedWidth,
    maxHeight: Math.max(0, viewport.height - top - margin),
  };
}
