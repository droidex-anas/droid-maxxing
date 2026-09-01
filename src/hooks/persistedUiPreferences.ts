import { sanitizePersistedPrWorkspace } from '../features/pull-requests/lib/prWorkspaceCwd';
import { sanitizePersistedPrBacklog } from '../features/pull-requests/lib/prBacklog';
import type { BrowserState, ModelInfo, ReasoningEffort } from '../types/bridge';
import { DIFF_SCOPES, type DiffScope } from '../types/vcs';
import type { ImagePasteQuality } from '../lib/images';
import {
  persistUtilityPanels,
  sanitizeUtilityPanels,
  type UtilityPanelState,
} from '../lib/utilityPanel';
import {
  loadPersistedBrowserOpenKeys,
  loadPersistedBrowsers,
  persistBrowsers,
} from './persistedBrowserSnapshot';

export type AgentKind = 'primary' | 'worker' | 'validator';
export type LiveEnterBehavior = 'queue' | 'interrupt';
export type DiffViewMode = 'unified' | 'split';

export interface AgentModelConfig {
  modelId?: string;
  reasoning: ReasoningEffort;
}

export type AgentConfig = Record<AgentKind, AgentModelConfig>;

const AGENT_CONFIG_STORAGE_KEY = 'droid-agent-config-v2';
const defaultAgentConfig: AgentConfig = {
  primary: { modelId: undefined, reasoning: 'high' },
  worker: { modelId: undefined, reasoning: 'medium' },
  validator: { modelId: undefined, reasoning: 'medium' },
};

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic'
  );
}

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

export function loadAgentConfig(): AgentConfig {
  try {
    const storage = getLocalStorage();
    if (!storage) return defaultAgentConfig;
    const raw = storage.getItem(AGENT_CONFIG_STORAGE_KEY);
    if (!raw) return defaultAgentConfig;
    const parsed = JSON.parse(raw) as Partial<Record<AgentKind, Partial<AgentModelConfig>>>;
    return {
      primary: readAgentConfig(parsed.primary, defaultAgentConfig.primary),
      worker: readAgentConfig(parsed.worker, defaultAgentConfig.worker),
      validator: readAgentConfig(parsed.validator, defaultAgentConfig.validator),
    };
  } catch {
    return defaultAgentConfig;
  }
}

function readAgentConfig(
  value: Partial<AgentModelConfig> | undefined,
  fallback: AgentModelConfig,
): AgentModelConfig {
  return {
    modelId: typeof value?.modelId === 'string' && value.modelId ? value.modelId : fallback.modelId,
    reasoning: isReasoningEffort(value?.reasoning) ? value.reasoning : fallback.reasoning,
  };
}

export function saveAgentConfig(config: AgentConfig): AgentConfig {
  try {
    getLocalStorage()?.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
  return config;
}

// Global compaction model: 'current-model' means each session compacts with
// whatever model it is currently using; otherwise a specific model id is used
// for compaction across every session.
const COMPACTION_MODEL_STORAGE_KEY = 'droid-compaction-model';
const LIVE_ENTER_BEHAVIOR_STORAGE_KEY = 'droid-live-enter-behavior';
const IMAGE_PASTE_QUALITY_STORAGE_KEY = 'droid-image-paste-quality';
const DIFF_VIEW_STORAGE_KEY = 'droid-diff-view';
const REVIEW_SCOPE_STORAGE_KEY = 'droid-review-scope';
const WORKSPACES_STORAGE_KEY = 'droid-workspaces';
const SESSION_LAST_SEEN_STORAGE_KEY = 'droid-session-last-seen-v1';
const UI_STATE_STORAGE_KEY = 'droid-ui-state-v2';

interface PersistedUiState {
  activeAppSessionId: string | null;
  rightPanelOpen: boolean;
  utilityPanels: Record<string, UtilityPanelState>;
  sidebarCollapsed: boolean;
  specMode: boolean;
  missionControlMode: boolean;
  browsers: Record<string, BrowserState>;
  browserOpenKeys: Record<string, boolean>;
  selectedFeatureId: string | null;
  mainView?: 'session' | 'pull-requests';
  prWorkspaceCwd?: string | null;
  prWorkspaceNumber?: number | null;
  prBacklogIds?: string[];
}

export function loadCompactionModel(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string means use default model
    return getLocalStorage()?.getItem(COMPACTION_MODEL_STORAGE_KEY) || 'current-model';
  } catch {
    return 'current-model';
  }
}

export function saveCompactionModel(value: string): string {
  try {
    getLocalStorage()?.setItem(COMPACTION_MODEL_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
  return value;
}

function normalizeLiveEnterBehavior(value: unknown): LiveEnterBehavior {
  return value === 'interrupt' ? 'interrupt' : 'queue';
}

export function loadLiveEnterBehavior(): LiveEnterBehavior {
  try {
    return normalizeLiveEnterBehavior(getLocalStorage()?.getItem(LIVE_ENTER_BEHAVIOR_STORAGE_KEY));
  } catch {
    return 'queue';
  }
}

export function saveLiveEnterBehavior(value: LiveEnterBehavior): LiveEnterBehavior {
  const behavior = normalizeLiveEnterBehavior(value);
  try {
    getLocalStorage()?.setItem(LIVE_ENTER_BEHAVIOR_STORAGE_KEY, behavior);
  } catch {
    /* ignore */
  }
  return behavior;
}

function normalizeImagePasteQuality(value: unknown): ImagePasteQuality {
  return value === 'high' || value === 'compact' ? value : 'original';
}

export function loadImagePasteQuality(): ImagePasteQuality {
  try {
    return normalizeImagePasteQuality(getLocalStorage()?.getItem(IMAGE_PASTE_QUALITY_STORAGE_KEY));
  } catch {
    return 'original';
  }
}

export function saveImagePasteQuality(value: ImagePasteQuality): ImagePasteQuality {
  const quality = normalizeImagePasteQuality(value);
  try {
    getLocalStorage()?.setItem(IMAGE_PASTE_QUALITY_STORAGE_KEY, quality);
  } catch {
    /* ignore */
  }
  return quality;
}

export function loadDiffView(): DiffViewMode {
  try {
    return getLocalStorage()?.getItem(DIFF_VIEW_STORAGE_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

export function saveDiffView(value: DiffViewMode): DiffViewMode {
  const mode = value === 'split' ? 'split' : 'unified';
  try {
    getLocalStorage()?.setItem(DIFF_VIEW_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  return mode;
}

export function loadReviewScope(): DiffScope {
  try {
    const raw = getLocalStorage()?.getItem(REVIEW_SCOPE_STORAGE_KEY) as DiffScope | null;
    return raw && DIFF_SCOPES.includes(raw) ? raw : 'unstaged';
  } catch {
    return 'unstaged';
  }
}

export function saveReviewScope(value: DiffScope): DiffScope {
  const scope = DIFF_SCOPES.includes(value) ? value : 'unstaged';
  try {
    getLocalStorage()?.setItem(REVIEW_SCOPE_STORAGE_KEY, scope);
  } catch {
    /* ignore */
  }
  return scope;
}

export function loadWorkspaceCwds(): string[] {
  try {
    const raw = getLocalStorage()?.getItem(WORKSPACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

export function saveWorkspaceCwds(cwds: string[]): string[] {
  try {
    getLocalStorage()?.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(cwds));
  } catch {
    /* ignore */
  }
  return cwds;
}

export function loadPersistedUiState(): Partial<PersistedUiState> {
  try {
    const raw = getLocalStorage()?.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedUiState>;
    return {
      ...sanitizePersistedPrWorkspace(parsed.prWorkspaceCwd, parsed.prWorkspaceNumber),
      prBacklogIds: sanitizePersistedPrBacklog(parsed.prBacklogIds),
      activeAppSessionId:
        typeof parsed.activeAppSessionId === 'string' ? parsed.activeAppSessionId : null,
      rightPanelOpen:
        typeof parsed.rightPanelOpen === 'boolean' ? parsed.rightPanelOpen : undefined,
      utilityPanels: sanitizeUtilityPanels(parsed.utilityPanels),
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean' ? parsed.sidebarCollapsed : undefined,
      specMode: typeof parsed.specMode === 'boolean' ? parsed.specMode : undefined,
      missionControlMode:
        typeof parsed.missionControlMode === 'boolean' ? parsed.missionControlMode : undefined,
      browsers: loadPersistedBrowsers(parsed.browsers),
      browserOpenKeys: loadPersistedBrowserOpenKeys(parsed.browserOpenKeys),
      selectedFeatureId:
        typeof parsed.selectedFeatureId === 'string' ? parsed.selectedFeatureId : null,
      mainView:
        parsed.mainView === 'session' || parsed.mainView === 'pull-requests'
          ? parsed.mainView
          : undefined,
    };
  } catch {
    return {};
  }
}

export interface PersistedUiStateSource {
  activeAppSessionId: string | null;
  rightPanelOpen: boolean;
  utilityPanels: Record<string, UtilityPanelState>;
  sidebarCollapsed: boolean;
  specMode: boolean;
  missionControlMode: boolean;
  browsers: Record<string, BrowserState>;
  browserOpenKeys: Record<string, boolean>;
  selectedFeatureId: string | null;
  mainView: 'session' | 'pull-requests';
  prWorkspaceCwd: string | null;
  prWorkspaceNumber: number | null;
  prBacklogIds: string[];
}

export function savePersistedUiState(state: PersistedUiStateSource): void {
  const snapshot: PersistedUiState = {
    activeAppSessionId: state.activeAppSessionId,
    rightPanelOpen: state.rightPanelOpen,
    utilityPanels: persistUtilityPanels(state.utilityPanels),
    sidebarCollapsed: state.sidebarCollapsed,
    specMode: state.specMode,
    missionControlMode: state.missionControlMode,
    browsers: persistBrowsers(state.browsers),
    browserOpenKeys: state.browserOpenKeys,
    selectedFeatureId: state.selectedFeatureId,
    mainView: state.mainView,
    prWorkspaceCwd: state.prWorkspaceCwd,
    prWorkspaceNumber: state.prWorkspaceNumber,
    prBacklogIds: state.prBacklogIds,
  };
  try {
    getLocalStorage()?.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore */
  }
}

export function loadSessionLastSeen(): Record<string, number> {
  try {
    const raw = getLocalStorage()?.getItem(SESSION_LAST_SEEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSessionLastSeen(map: Record<string, number>): void {
  try {
    getLocalStorage()?.setItem(SESSION_LAST_SEEN_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function sanitizeAgentConfig(config: AgentConfig, models: ModelInfo[]): AgentConfig {
  if (models.length === 0) return config;
  return {
    primary: sanitizeAgent(config.primary, models),
    worker: sanitizeAgent(config.worker, models),
    validator: sanitizeAgent(config.validator, models),
  };
}

function sanitizeAgent(config: AgentModelConfig, models: ModelInfo[]): AgentModelConfig {
  if (!config.modelId) return config;
  const model = models.find((item) => item.id === config.modelId);
  if (!model) return { modelId: undefined, reasoning: config.reasoning };
  const supported = model.supportedReasoningEfforts;
  if (supported?.length && !supported.includes(config.reasoning)) {
    return { modelId: config.modelId, reasoning: model.defaultReasoningEffort ?? supported[0] };
  }
  if (
    !supported?.length &&
    model.defaultReasoningEffort &&
    config.reasoning !== model.defaultReasoningEffort
  ) {
    return { modelId: config.modelId, reasoning: model.defaultReasoningEffort };
  }
  return config;
}
