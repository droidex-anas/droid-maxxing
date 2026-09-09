// Every length here is a CSS pixel of the zoomed UI root. The root applies
// `zoom: var(--ui-zoom)`, so callers convert viewport measurements with
// `parseUiScale` before positioning and after measuring.
export interface PopoverPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'above' | 'below';
}

export interface PopoverPositionInput {
  anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
  viewportWidth: number;
  viewportHeight: number;
  measuredHeight: number;
  requestedWidth: number;
  align: 'start' | 'end';
  gap: number;
  edge?: number;
  maximumHeight?: number;
}

export function calculatePopoverPosition({
  anchor,
  viewportWidth,
  viewportHeight,
  measuredHeight,
  requestedWidth,
  align,
  gap,
  edge = 10,
  maximumHeight = 420,
}: PopoverPositionInput): PopoverPosition {
  const availableWidth = Math.max(220, viewportWidth - edge * 2);
  const width = Math.min(requestedWidth, availableWidth);
  const below = Math.max(0, viewportHeight - anchor.bottom - gap - edge);
  const above = Math.max(0, anchor.top - gap - edge);
  const expectedHeight = Math.min(Math.max(1, measuredHeight), maximumHeight);
  const placement: PopoverPosition['placement'] =
    below >= Math.min(expectedHeight, 220) || below >= above ? 'below' : 'above';
  const availableHeight = placement === 'below' ? below : above;
  const maxHeight = Math.max(1, Math.min(maximumHeight, availableHeight));
  const renderedHeight = Math.min(expectedHeight, maxHeight);
  const desiredLeft = align === 'end' ? anchor.right - width : anchor.left;
  const left = Math.min(viewportWidth - width - edge, Math.max(edge, desiredLeft));
  const desiredTop =
    placement === 'below' ? anchor.bottom + gap : anchor.top - gap - renderedHeight;
  const top = Math.min(viewportHeight - renderedHeight - edge, Math.max(edge, desiredTop));
  return { left, top, width, maxHeight, placement };
}

export function parseUiScale(zoom: string | undefined): number {
  const parsed = Number.parseFloat(zoom ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function samePopoverPosition(left: PopoverPosition | null, right: PopoverPosition): boolean {
  return Boolean(
    left &&
    Math.abs(left.left - right.left) < 0.5 &&
    Math.abs(left.top - right.top) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.maxHeight - right.maxHeight) < 0.5 &&
    left.placement === right.placement,
  );
}
