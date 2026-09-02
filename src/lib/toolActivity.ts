export type ToolActivityDensity = 'compact' | 'balanced' | 'detailed';

export interface ToolActivitySettings {
  density: ToolActivityDensity;
  // Whether folded diff runs render expanded by default. Off collapses the
  // whole diff group behind its header line.
  inlineDiffs: boolean;
}

const TOOL_ACTIVITY_STORAGE_KEY = 'droid-tool-activity';
export const DEFAULT_TOOL_ACTIVITY: ToolActivitySettings = {
  density: 'balanced',
  inlineDiffs: true,
};

const DENSITIES: readonly ToolActivityDensity[] = ['compact', 'balanced', 'detailed'];

function normalizeDensity(value: unknown): ToolActivityDensity {
  return DENSITIES.includes(value as ToolActivityDensity)
    ? (value as ToolActivityDensity)
    : DEFAULT_TOOL_ACTIVITY.density;
}

function normalizeToolActivity(value: unknown): ToolActivitySettings {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return {
      density: normalizeDensity(record.density),
      inlineDiffs: record.inlineDiffs !== false,
    };
  }
  return DEFAULT_TOOL_ACTIVITY;
}

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

export function loadToolActivity(): ToolActivitySettings {
  try {
    const raw = storage()?.getItem(TOOL_ACTIVITY_STORAGE_KEY);
    if (raw == null) return DEFAULT_TOOL_ACTIVITY;
    return normalizeToolActivity(JSON.parse(raw));
  } catch {
    return DEFAULT_TOOL_ACTIVITY;
  }
}

export function saveToolActivity(value: ToolActivitySettings): ToolActivitySettings {
  const settings = normalizeToolActivity(value);
  try {
    storage()?.setItem(TOOL_ACTIVITY_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
  return settings;
}
