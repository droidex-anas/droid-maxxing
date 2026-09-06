export type BackgroundWorkTier = 'interactive' | 'hidden' | 'low-power';

export function resolveBackgroundWorkTier(input: {
  windowVisible?: boolean;
  documentVisible?: boolean;
  onBattery?: boolean;
}): BackgroundWorkTier {
  const visible = input.windowVisible !== false && input.documentVisible !== false;
  if (visible) return 'interactive';
  return input.onBattery ? 'low-power' : 'hidden';
}
