export type ToolActivityDensity = 'compact' | 'verbose';

export const TOOL_ACTIVITY_STORAGE_KEY = 'droid-tool-activity';
export const DEFAULT_TOOL_ACTIVITY_DENSITY: ToolActivityDensity = 'compact';

export function normalizeToolActivityDensity(value: unknown): ToolActivityDensity {
  return value === 'verbose' ? 'verbose' : 'compact';
}

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

export function loadToolActivityDensity(): ToolActivityDensity {
  try {
    return normalizeToolActivityDensity(storage()?.getItem(TOOL_ACTIVITY_STORAGE_KEY));
  } catch {
    return DEFAULT_TOOL_ACTIVITY_DENSITY;
  }
}

export function saveToolActivityDensity(value: ToolActivityDensity): ToolActivityDensity {
  const density = normalizeToolActivityDensity(value);
  try {
    storage()?.setItem(TOOL_ACTIVITY_STORAGE_KEY, density);
  } catch {
    /* ignore */
  }
  return density;
}
