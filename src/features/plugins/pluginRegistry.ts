import type { PluginDefinition, PluginMarketplace } from './pluginCatalog';

const STORAGE_KEY = 'droidex-plugin-registry-v2';
const LEGACY_STORAGE_KEY = 'droidex-plugin-registry-v1';
export const PLUGIN_REGISTRY_EVENT = 'droidex:plugin-registry-changed';

export interface InstalledPluginRecord {
  pluginId: string;
  installedAt: number;
  updatedAt: number;
}

export interface ConnectorRecord {
  slug: string;
  ready: boolean;
  updatedAt: number;
}

export interface RegisteredMarketplaceRecord {
  id: string;
  cliName: string;
  name: string;
  sourceUrl: string;
  addedAt: number;
}

export interface PluginRegistryState {
  version: 2;
  installed: Record<string, InstalledPluginRecord>;
  connectors: Record<string, ConnectorRecord>;
  marketplaces: RegisteredMarketplaceRecord[];
  legacy: {
    githubPatPluginDetected: boolean;
  };
}

export const EMPTY_PLUGIN_REGISTRY: PluginRegistryState = {
  version: 2,
  installed: {},
  connectors: {},
  marketplaces: [],
  legacy: { githubPatPluginDetected: false },
};

const LEGACY_PLUGIN_IDS: Record<string, string> = {
  'factory-official/droid-control': 'factory/droid-control',
  'factory-official/droid-evolved': 'factory/droid-evolved',
  'factory-official/security-engineer': 'factory/security-engineer',
  'factory-official/typescript': 'factory/typescript',
  'factory-official/debugging': 'factory/debugging',
  'factory-official/code-review': 'factory/code-review',
  'factory-official/autoresearch': 'factory/autoresearch',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeInstalled(value: unknown): Record<string, InstalledPluginRecord> {
  if (!isRecord(value)) return {};
  const records: Record<string, InstalledPluginRecord> = {};
  for (const [pluginId, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.installedAt !== 'number' || typeof candidate.updatedAt !== 'number') {
      continue;
    }
    records[pluginId] = {
      pluginId,
      installedAt: candidate.installedAt,
      updatedAt: candidate.updatedAt,
    };
  }
  return records;
}

function normalizeConnectors(value: unknown): Record<string, ConnectorRecord> {
  if (!isRecord(value)) return {};
  const records: Record<string, ConnectorRecord> = {};
  for (const [slug, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.ready !== 'boolean' || typeof candidate.updatedAt !== 'number') continue;
    records[slug] = { slug, ready: candidate.ready, updatedAt: candidate.updatedAt };
  }
  return records;
}

function normalizeMarketplaces(value: unknown): RegisteredMarketplaceRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const records: RegisteredMarketplaceRecord[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.cliName !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.sourceUrl !== 'string' ||
      typeof candidate.addedAt !== 'number' ||
      seen.has(candidate.id)
    ) {
      continue;
    }
    seen.add(candidate.id);
    records.push({
      id: candidate.id,
      cliName: candidate.cliName,
      name: candidate.name,
      sourceUrl: candidate.sourceUrl,
      addedAt: candidate.addedAt,
    });
  }
  return records;
}

export function parsePluginRegistry(serialized: string | null): PluginRegistryState {
  if (!serialized) return EMPTY_PLUGIN_REGISTRY;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== 2) return EMPTY_PLUGIN_REGISTRY;
    const legacy = isRecord(parsed.legacy) ? parsed.legacy : {};
    return {
      version: 2,
      installed: normalizeInstalled(parsed.installed),
      connectors: normalizeConnectors(parsed.connectors),
      marketplaces: normalizeMarketplaces(parsed.marketplaces),
      legacy: {
        githubPatPluginDetected: legacy.githubPatPluginDetected === true,
      },
    };
  } catch {
    return EMPTY_PLUGIN_REGISTRY;
  }
}

function migrateLegacyRegistry(serialized: string | null): PluginRegistryState {
  if (!serialized) return EMPTY_PLUGIN_REGISTRY;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.installed)) {
      return EMPTY_PLUGIN_REGISTRY;
    }
    const installed: Record<string, InstalledPluginRecord> = {};
    let githubPatPluginDetected = false;
    for (const [legacyId, candidate] of Object.entries(parsed.installed)) {
      if (!isRecord(candidate)) continue;
      if (legacyId === 'claude-official/github') {
        githubPatPluginDetected = true;
        continue;
      }
      const pluginId = LEGACY_PLUGIN_IDS[legacyId];
      if (!pluginId) continue;
      const installedAt = typeof candidate.installedAt === 'number' ? candidate.installedAt : Date.now();
      const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : installedAt;
      installed[pluginId] = { pluginId, installedAt, updatedAt };
    }
    return {
      version: 2,
      installed,
      connectors: {},
      marketplaces: normalizeMarketplaces(parsed.marketplaces),
      legacy: { githubPatPluginDetected },
    };
  } catch {
    return EMPTY_PLUGIN_REGISTRY;
  }
}

export function loadPluginRegistry(): PluginRegistryState {
  if (typeof window === 'undefined') return EMPTY_PLUGIN_REGISTRY;
  try {
    const current = window.localStorage.getItem(STORAGE_KEY);
    if (current) return parsePluginRegistry(current);
    const migrated = migrateLegacyRegistry(window.localStorage.getItem(LEGACY_STORAGE_KEY));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return EMPTY_PLUGIN_REGISTRY;
  }
}

export function savePluginRegistry(state: PluginRegistryState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent(PLUGIN_REGISTRY_EVENT));
  } catch {
    // Keep the in-memory UI usable if storage is unavailable.
  }
}

export function markPluginInstalled(
  state: PluginRegistryState,
  plugin: PluginDefinition,
  now = Date.now(),
): PluginRegistryState {
  const existing = state.installed[plugin.id];
  return {
    ...state,
    installed: {
      ...state.installed,
      [plugin.id]: {
        pluginId: plugin.id,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      },
    },
  };
}

export function removePluginRecord(
  state: PluginRegistryState,
  pluginId: string,
): PluginRegistryState {
  if (!Object.hasOwn(state.installed, pluginId)) return state;
  const installed = { ...state.installed };
  delete installed[pluginId];
  return { ...state, installed };
}

export function markConnectorReady(
  state: PluginRegistryState,
  slug: string,
  ready: boolean,
  now = Date.now(),
): PluginRegistryState {
  const existing = state.connectors[slug];
  if (existing?.ready === ready) return state;
  return {
    ...state,
    connectors: {
      ...state.connectors,
      [slug]: { slug, ready, updatedAt: now },
    },
  };
}

export function clearLegacyGithubPluginFlag(state: PluginRegistryState): PluginRegistryState {
  if (!state.legacy.githubPatPluginDetected) return state;
  return {
    ...state,
    legacy: { ...state.legacy, githubPatPluginDetected: false },
  };
}

export function registerMarketplace(
  state: PluginRegistryState,
  marketplace: PluginMarketplace,
  now = Date.now(),
): PluginRegistryState {
  const record: RegisteredMarketplaceRecord = {
    id: marketplace.id,
    cliName: marketplace.cliName,
    name: marketplace.name,
    sourceUrl: marketplace.sourceUrl,
    addedAt: now,
  };
  return {
    ...state,
    marketplaces: [
      ...state.marketplaces.filter((candidate) => candidate.id !== marketplace.id),
      record,
    ],
  };
}

export function pluginIsAvailable(state: PluginRegistryState, plugin: PluginDefinition): boolean {
  if (plugin.adapter === 'github-cli') return state.connectors[plugin.slug]?.ready === true;
  return Boolean(state.installed[plugin.id]);
}
