import type { ReactNode } from 'react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { bridge } from '../lib/bridge';
import { normalizeAppIconMode, type AppIconMode } from '../lib/appIcon';
import { updateCompactionSettings } from '../lib/commands';
import {
  DEFAULT_THEME_ID,
  detectPresetId,
  migrateLegacyLightPreset,
  parseCustomThemes,
  removeCustomTheme,
  upsertCustomTheme,
  type ThemePreset,
} from '../lib/theme';
import {
  clearDesignMode,
  setDesignMode,
  toggleDesignMode,
  type DesignModes,
} from './designModeState';
import type {
  Autonomy,
  FactoryDefaultSettings,
  ServerEvent,
  SessionSummary,
  TranscriptEvent,
  ProgressEntry,
  PermissionRequest,
  SessionQuestion,
  ModelInfo,
  ChildSessionSummary,
  SkillInfo,
  ReasoningEffort,
  ContextStatsSnapshot,
  BrowserState,
  BrowserViewportMode,
  DesignReference,
} from '../types/bridge';
import { addWorkspaceCwd } from '../lib/workspaces';
import { createOrderedActionBatcher, type OrderedActionBatcher } from './orderedActionBatcher';
import { loadDefaultAutonomy, saveDefaultAutonomy } from '../lib/autonomy';
import {
  applyFactoryCompactionDefaults,
  compactionSettingsSnapshot,
  loadCompactionTokenLimit,
  loadCompactionTokenLimitPerModel,
  normalizeTokenLimit,
  saveCompactionTokenLimit,
  saveCompactionTokenLimitPerModel,
} from '../lib/compactionSettings';
import { sanitizeForLog } from '../lib/sensitiveLogRedaction';
import { sessionIsLive } from '../lib/sessions';
import { noteStoreCommitted, discardPendingBridgeEvent } from '../lib/rendererPerf';
import {
  addSessionNote,
  loadSessionNotes,
  markSessionNoteUsed,
  removeSessionNote,
  saveSessionNotes,
  type SessionNotesMap,
} from '../lib/sessionNotes';
import {
  archiveChat,
  deleteChat,
  loadChatMetadata,
  pinChat,
  renameChat,
  restoreChat,
  saveChatMetadata,
  unpinChat,
  type ChatMetadataMap,
} from '../lib/chatMetadata';
import { createSnapshotScheduler, loadSessionSnapshot } from '../lib/sessionSnapshot';
import { toast } from '../lib/toast';
import { DIFF_SCOPES, type DiffScope } from '../types/vcs';
import {
  activateUtilityTab,
  closeUtilityTab,
  openUtilityTool,
  persistUtilityPanels,
  removeUtilityTool,
  sanitizeUtilityPanels,
  setUtilityPanelOpen,
  updateUtilityTab,
  utilityPanelForSession,
  type UtilityPanelState,
  type UtilityTool,
} from '../lib/utilityPanel';
import type { ImagePasteQuality } from '../lib/images';
import {
  estimateTranscriptCost,
  INACTIVE_TRANSCRIPT_POLICY,
  VIEWPORT_TRANSCRIPT_POLICY,
} from '../lib/transcriptWindow';
import {
  appendTranscriptEvent,
  pruneRemovedSessionState,
  releaseSessionChildTranscriptWindow,
  releaseSessionTranscriptWindow,
  withUpdatedTranscript,
} from '../lib/transcriptStoreMemory';
import {
  reconcilePrependedTranscript,
  reconcileRestoredTranscript,
  reconcileTranscriptSourcePage,
} from '../lib/transcriptHistory';

export type AgentKind = 'primary' | 'worker' | 'validator';
export type ChildSettingsReadiness = 'opening' | 'ready' | 'failed';
export type LiveEnterBehavior = 'queue' | 'interrupt';
export type DiffViewMode = 'unified' | 'split';
export type { ImagePasteQuality } from '../lib/images';

export type ChildSessionInfo = ChildSessionSummary;

export interface ChildSelection {
  parentAppSessionId: string;
  childSessionId: string;
}

export type ChildAccess =
  | { state: 'opening'; requestId: string }
  | { state: 'ready'; requestId: string; runtimeGeneration: number }
  | { state: 'history'; requestId: string }
  | { state: 'failed'; requestId: string | null }
  | { state: 'closed'; requestId: null };

export interface ChildRuntimeState {
  available: boolean;
  runtimeGeneration: number;
}

export interface QueuedDesignContext {
  browserKey: string;
  references: DesignReference[];
  referenceIds: string[];
}

export interface QueuedPrompt {
  id: string;
  text: string;
  skills: string[];
  files: string[];
  design?: QueuedDesignContext;
}

export interface AgentModelConfig {
  modelId?: string;
  reasoning: ReasoningEffort;
}

export type AgentConfig = Record<AgentKind, AgentModelConfig>;

export type DiffStyle = 'soft' | 'focused';

export interface ThemeConfig {
  mode: 'dark' | 'light' | 'system';
  appIconMode: AppIconMode;
  // The preset the flattened colors came from: a built-in/custom theme id, or
  // 'custom' when the colors were edited by hand and match no preset.
  presetId: string;
  accent: string;
  bg: string;
  fg: string;
  surface: string;
  border: string;
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  translucentSidebar: boolean;
  diffStyle: DiffStyle;
  contrast: number;
}

export type SessionRestoreStatus = 'loading' | 'paged' | 'loaded' | 'failed';

export interface SessionRestore {
  status: SessionRestoreStatus;
  loadedCount: number;
  hasMore: boolean;
  error?: string;
}

export interface ChildHistoryState extends SessionRestore {
  isLoaded: boolean;
  isLoadingOlder: boolean;
  olderCursor?: string;
  isViewportPinned: boolean;
}

export interface AppState {
  // Connection
  connection: 'idle' | 'connecting' | 'connected' | 'error';
  connectionError?: string;

  // Sessions domain
  sessions: Record<string, SessionSummary>;
  sessionOrder: string[];
  // Ids vouched for by the last authoritative listing: the boot snapshot
  // before the first SESSION_LIST, then the sessions of the most recent
  // SESSION_LIST. A SESSION_LIST prunes confirmed rows it no longer reports,
  // so a session deleted outside the app disappears on the next list push.
  // Rows added locally this run (SESSION_CREATED/SESSION_UPDATED) are not in
  // the set and survive lists that do not mention them yet.
  listConfirmedSessionIds: string[] | null;
  activeAppSessionId: string | null;
  // appSessionId -> last time the user viewed it. A session reads as "unread" when
  // its updatedAt (latest model activity) is newer than this. Internal only:
  // surfaced as a bold row in the sidebar, never shown as a timestamp.
  sessionLastSeen: Record<string, number>;
  // App-level pin/archive/delete organization per chat. Pure renderer metadata,
  // persisted in localStorage; the harness session data is never touched.
  chatMetadata: ChatMetadataMap;
  transcripts: Record<string, TranscriptEvent[]>;
  // Relative retained-payload estimate for each in-memory transcript window.
  // This is budgeting telemetry, not a claim about exact V8 heap bytes.
  transcriptRetainedCost: Record<string, number>;
  // Primary transcript viewport state. Normal eviction is allowed only after
  // the viewport is bottom-pinned; scrolled-up reading stays resident.
  transcriptViewportPinned: Partial<Record<string, boolean>>;
  progress: Record<string, ProgressEntry[]>;
  childSessions: Record<string, Record<string, ChildSessionInfo>>;
  historyLoaded: Record<string, boolean>;
  // Cursor for the next older page of primary-session scrollback;
  // undefined/absent once the oldest compaction segment has been loaded.
  historyCursor: Record<string, string | undefined>;
  // Whether an older-history page is currently in flight (prevents duplicate
  // prefetches while the user keeps scrolling up).
  historyLoadingOlder: Record<string, boolean>;
  // Explicit transcript-restore state per session: whether the initial replay
  // is loading, partially loaded (older pages remain), fully loaded, or failed.
  // Lets the chat show an honest restoring/partial/retry surface instead of a
  // blank or silently truncated transcript (#29).
  sessionRestore: Partial<Record<string, SessionRestore>>;
  // Child transcripts share the parent event array for live rendering, but
  // each logical child owns an independent persisted-history cursor and
  // viewport lifecycle.
  childHistory: Record<string, Record<string, ChildHistoryState>>;
  childAccess: Record<string, Record<string, ChildAccess>>;
  childRuntime: Record<string, Record<string, ChildRuntimeState>>;
  // Pending permission requests are scoped to the session that asked, so a
  // request from one chat never appears (or gets answered) in another.
  pendingPermissions: Record<string, PermissionRequest>;
  // Same scoping for AskUser questions: keyed by the asking session.
  pendingQuestions: Record<string, SessionQuestion>;
  contextStats: {
    primary: Record<string, ContextStatsSnapshot>;
    child: Record<string, Record<string, ContextStatsSnapshot>>;
  };
  specPlans: Record<string, string>; // latest ExitSpecMode plan per session
  // Persisted spec per session (file path + rendered content). Survives exiting
  // spec mode so the inline card, mermaid, and the wiki reader stay available.
  sessionSpecs: Record<string, { path?: string; title: string; content: string }>;
  // Which session's spec is open in the full wiki reader (null = closed).
  specWikiAppSessionId: string | null;
  // Held locally until the current turn finishes, then delivered one at a time.
  promptQueue: Record<string, QueuedPrompt[]>;
  // Scratch notes parked from the Context panel, per session. Persisted in
  // localStorage so reminders survive app restarts.
  sessionNotes: SessionNotesMap;

  // UI flags
  rightPanelOpen: boolean;
  utilityPanels: Record<string, UtilityPanelState>;
  // The Review diff tab: a wide right-side pane, opened from the Context panel's
  // changes button. Scope + view mode persist; open state is per-session — we
  // track the session it was opened for so switching chats doesn't carry it over.
  reviewOpenAppSessionId: string | null;
  reviewScope: DiffScope;
  // A file path the Review pane should jump to once its list loads, set when a
  // per-turn changes summary (or diff card) is clicked. Cleared after the jump.
  reviewFocusPath: string | null;
  // Generation counter for focus requests: every OPEN_REVIEW_AT bumps it so
  // the Review pane can tell a fresh click apart from a re-render of the
  // previous request (a repeated click must re-arm the scope-fallback dedupe).
  reviewFocusRequestId: number;
  diffView: DiffViewMode;
  sidebarCollapsed: boolean;
  specMode: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  theme: ThemeConfig;
  // User-saved theme presets (built-ins live in lib/theme). Persisted to
  // localStorage; the active one is referenced by theme.presetId.
  customThemes: ThemePreset[];
  missionControlMode: boolean;
  draftChat: {
    cwd: string;
    executionMode: 'worktree' | 'local';
    branch?: string;
  } | null;
  // Persisted app-wide default autonomy for new sessions. Owned by Settings;
  // factory-default reloads and draft/session changes never overwrite it.
  defaultAutonomy: Autonomy;
  // Autonomy override for the current unsent draft. Null means the draft
  // follows `defaultAutonomy`; reset whenever the draft lifecycle resets.
  draftAutonomy: Autonomy | null;
  // Live-session autonomy changes awaiting provider confirmation, keyed by
  // appSessionId. The UI keeps showing the confirmed value while pending.
  pendingAutonomy: Record<string, Autonomy>;
  // One-shot text seeded into the composer (welcome-screen suggestion cards,
  // saved-note clicks). A fresh id per seed lets re-clicking re-arm the effect.
  composerSeed: { text: string; id: number } | null;
  workspaceCwds: string[];
  // Derived (synced by the reducer): whether the browser pane is open for the
  // *currently active* session. Source of truth is `browserOpenKeys`.
  browserOpen: boolean;
  // Per-session browser-pane open state, keyed by browser key (the chat/session
  // id). Presence means "open"; absence means "closed". Persisted so a session
  // resumes where it left off after an app restart, unless it was fully closed.
  browserOpenKeys: Record<string, boolean>;
  browsers: Record<string, BrowserState>;
  browserErrors: Record<string, string>;
  browserGlobalError?: string;
  designModes: DesignModes;

  // Mission Control view
  selectedFeatureId: string | null;
  selectedChild: ChildSelection | null;

  // Models / per-agent config
  models: ModelInfo[];
  agentConfig: AgentConfig;

  // Global compaction model applied to every session. 'current-model' = use
  // each session's active model; otherwise a specific model id.
  compactionModel: string;

  // Global default compaction token limit applied to every session. Undefined
  // means "use Factory's model-dependent default".
  compactionTokenLimit?: number;
  // Per-model overrides for the compaction token limit, keyed by model id.
  compactionTokenLimitPerModel: Record<string, number>;
  // Bumped on every compaction-settings change (including clears that leave
  // the values structurally identical, e.g. undefined -> cleared undefined) so
  // the push effect always re-fires and the sidecar snapshot never goes stale.
  compactionSettingsRev: number;
  liveEnterBehavior: LiveEnterBehavior;
  // Fidelity tier for images pasted or dropped into the composer.
  imagePasteQuality: ImagePasteQuality;

  // Per-session model/reasoning the user picked in the selector. These are
  // authoritative: a stale server summary (e.g. an in-flight resume) must not
  // revert the user's choice back to the session default.
  sessionSettingOverrides: Record<string, { modelId?: string; reasoningEffort?: ReasoningEffort }>;

  // Skills catalog (for / invocation)
  skills: SkillInfo[];
  skillsProviderSessionId?: string | null;

  // Attachments for the first message of a not-yet-created session, keyed by clientRef.
  pendingCompose: Partial<Record<string, { text: string; skills: string[]; files: string[] }>>;
  // Bounded settlement identity for the latest successful foreground create.
  // PromptInput uses it to distinguish that activation from a failure followed
  // by the user selecting an unrelated existing session.
  lastCreatedSessionRequest: { clientRef: string; appSessionId: string } | null;
}

type Action =
  | { type: 'BATCH'; actions: Action[] }
  // Connection
  | {
      type: 'SET_CONNECTION';
      status: 'idle' | 'connecting' | 'connected' | 'error';
      message?: string;
    }

  // Session lifecycle
  | { type: 'SESSION_CREATED'; clientRef: string; session: SessionSummary }
  | {
      type: 'SET_PENDING_COMPOSE';
      clientRef: string;
      text: string;
      skills: string[];
      files: string[];
    }
  | { type: 'SESSION_UPDATED'; session: SessionSummary }
  | { type: 'SESSION_CLOSED'; appSessionId: string }
  // App-level chat organization (rename/pin/archive/delete); see lib/chatMetadata.
  // A blank RENAME_CHAT title clears the override back to the generated title.
  | { type: 'RENAME_CHAT'; appSessionId: string; title: string }
  | { type: 'PIN_CHAT'; appSessionId: string }
  | { type: 'UNPIN_CHAT'; appSessionId: string }
  | { type: 'ARCHIVE_CHAT'; appSessionId: string }
  | { type: 'RESTORE_CHAT'; appSessionId: string }
  | { type: 'DELETE_CHAT'; appSessionId: string }
  | { type: 'SESSION_FEATURES'; appSessionId: string; features: SessionSummary['features'] }
  | { type: 'SESSION_PROGRESS'; appSessionId: string; entries: ProgressEntry[] }
  | {
      type: 'SESSION_CHILD';
      child: ChildSessionSummary;
      runtimeAvailable: boolean;
      runtimeGeneration: number;
    }
  | (
      | {
          type: 'CHILD_UPDATED';
          parentAppSessionId: string;
          childSessionId: string;
          requestId: string;
          access: 'ready';
          runtimeGeneration: number;
        }
      | {
          type: 'CHILD_UPDATED';
          parentAppSessionId: string;
          childSessionId: string;
          requestId: string;
          access: 'history';
        }
    )
  | {
      type: 'CHILD_ERROR';
      parentAppSessionId: string;
      childSessionId: string;
      requestId: string | null;
      operation: 'open' | 'loadHistory' | 'send' | 'sendNow' | 'interrupt' | 'settings';
      message: string;
    }
  | {
      type: 'SESSION_TOKENS';
      appSessionId: string;
      tokensIn: number;
      tokensOut: number;
      contextTokens: number;
      maxContextTokens?: number;
    }
  | {
      type: 'CONTEXT_UPDATED';
      appSessionId: string;
      sourceSessionId: string;
      parentAppSessionId?: string;
      childSessionId?: string;
      stats: ContextStatsSnapshot;
    }
  | { type: 'SESSION_TRANSCRIPT'; event: TranscriptEvent }
  | { type: 'TRANSCRIPT_VIEWPORT'; appSessionId: string; pinned: boolean }
  | { type: 'TRANSCRIPT_RELEASE_VIEWPORT'; appSessionId: string }
  | { type: 'QUEUE_PROMPT'; appSessionId: string; prompt: QueuedPrompt }
  | { type: 'REMOVE_QUEUED_PROMPT'; appSessionId: string; id: string }
  | { type: 'REORDER_QUEUE'; appSessionId: string; from: number; to: number }
  | { type: 'SPEC_SET'; appSessionId: string; path?: string; title: string; content: string }
  | { type: 'SPEC_OPEN_WIKI'; appSessionId: string }
  | { type: 'SPEC_CLOSE_WIKI' }
  | { type: 'SESSION_PERMISSION'; request: PermissionRequest }
  | { type: 'SESSION_QUESTION'; question: SessionQuestion }
  | {
      type: 'SESSION_ERROR';
      appSessionId?: string;
      providerSessionId?: string;
      message: string;
    }
  | { type: 'SESSION_CREATE_FAILED'; clientRef: string; message: string }
  | { type: 'SESSION_LIST'; sessions: SessionSummary[] }
  | {
      type: 'SESSION_HISTORY';
      appSessionId: string;
      childSessionId?: string;
      progress: ProgressEntry[];
      transcripts: TranscriptEvent[];
      childSessions?: ChildSessionSummary[];
      mode?: 'replace' | 'prepend';
      olderCursor?: string;
      loadedCount?: number;
      hasMore?: boolean;
    }
  | { type: 'SESSION_RESTORE_START'; appSessionId: string }
  | {
      type: 'SESSION_HISTORY_FAILED';
      appSessionId: string;
      childSessionId?: string;
      message: string;
    }
  | { type: 'SESSION_HISTORY_LOADING_OLDER'; appSessionId: string }
  | {
      type: 'CHILD_HISTORY_LOADING';
      parentAppSessionId: string;
      childSessionId: string;
    }
  | {
      type: 'CHILD_HISTORY_LOADING_OLDER';
      parentAppSessionId: string;
      childSessionId: string;
    }
  | {
      type: 'CHILD_TRANSCRIPT_VIEWPORT';
      parentAppSessionId: string;
      childSessionId: string;
      pinned: boolean;
    }
  | {
      type: 'CHILD_TRANSCRIPT_RELEASE_VIEWPORT';
      parentAppSessionId: string;
      childSessionId: string;
    }
  | { type: 'CLEAR_PERMISSION'; appSessionId: string }
  | { type: 'CLEAR_QUESTION'; appSessionId: string }

  // UI
  | { type: 'SET_ACTIVE_SESSION'; id: string | null }
  | { type: 'MARK_ALL_SESSIONS_READ'; seenAt: number }
  | { type: 'SET_RIGHT_PANEL'; open: boolean }
  | {
      type: 'OPEN_UTILITY_TOOL';
      tool: UtilityTool;
      tabId?: string;
      terminalId?: string;
      cwd?: string;
      filePath?: string;
    }
  | { type: 'CLOSE_UTILITY_TAB'; tabId: string; appSessionId?: string }
  | { type: 'ACTIVATE_UTILITY_TAB'; tabId: string }
  | {
      type: 'UPDATE_UTILITY_TAB';
      tabId: string;
      appSessionId?: string;
      terminalId?: string;
      cwd?: string;
      filePath?: string;
      label?: string;
    }
  | { type: 'SET_UTILITY_PANEL_OPEN'; open: boolean }
  | { type: 'SET_REVIEW_OPEN'; open: boolean }
  | { type: 'SET_REVIEW_SCOPE'; scope: DiffScope }
  | { type: 'OPEN_REVIEW_AT'; scope: DiffScope; path?: string | null }
  | { type: 'CLEAR_REVIEW_FOCUS' }
  | { type: 'SET_DIFF_VIEW'; mode: DiffViewMode }
  | { type: 'TOGGLE_COMMAND_PALETTE' }
  | { type: 'CLOSE_COMMAND_PALETTE' }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_SPEC_MODE' }
  | {
      type: 'SESSION_SET_INTERACTION_MODE';
      appSessionId: string;
      interactionMode: SessionSummary['interactionMode'];
    }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'TOGGLE_MISSION_CONTROL' }
  | {
      type: 'START_CHAT';
      cwd: string;
      executionMode: 'worktree' | 'local';
      branch?: string;
    }
  | { type: 'SEED_COMPOSER'; text: string }
  | { type: 'CLEAR_COMPOSER_SEED' }
  | { type: 'SESSION_NOTE_ADD'; appSessionId: string; text: string }
  | { type: 'SESSION_NOTE_MARK_USED'; appSessionId: string; noteId: string }
  | { type: 'SESSION_NOTE_REMOVE'; appSessionId: string; noteId: string }
  | { type: 'ADD_WORKSPACE'; cwd: string }
  | { type: 'SET_WORKSPACE_CWDS'; cwds: string[] }
  | { type: 'TOGGLE_BROWSER' }
  | { type: 'SET_BROWSER_OPEN'; open: boolean }
  | { type: 'BROWSER_UPDATED'; browser: BrowserState }
  | {
      type: 'BROWSER_NAVIGATED';
      appSessionId: string;
      browserSessionId: string;
      url: string;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }
  | { type: 'BROWSER_CLOSED'; appSessionId: string }
  | { type: 'BROWSER_ERROR'; appSessionId?: string; message: string }
  | { type: 'TOGGLE_DESIGN_MODE'; appSessionId: string }
  | { type: 'SET_DESIGN_MODE'; appSessionId: string; open: boolean }
  | { type: 'SET_THEME'; theme: Partial<ThemeConfig> }
  | { type: 'SAVE_CUSTOM_THEME'; preset: ThemePreset }
  | { type: 'DELETE_CUSTOM_THEME'; id: string }
  | { type: 'SELECT_FEATURE'; id: string | null }
  | { type: 'SELECT_CHILD'; selection: ChildSelection | null; requestId?: string }

  // Models / per-agent config
  | { type: 'MODELS_LIST'; models: ModelInfo[] }
  | {
      type: 'SKILLS_LIST';
      skills: SkillInfo[];
      providerSessionId: string | null;
    }
  | { type: 'FACTORY_DEFAULTS'; defaults: FactoryDefaultSettings }
  | { type: 'SET_AGENT_MODEL'; agent: AgentKind; modelId?: string }
  | { type: 'SET_AGENT_REASONING'; agent: AgentKind; reasoning: ReasoningEffort }
  | { type: 'SESSION_SET_MODEL'; appSessionId: string; modelId?: string }
  | { type: 'SESSION_SET_REASONING'; appSessionId: string; reasoning: ReasoningEffort }
  | { type: 'SET_COMPACTION_MODEL_GLOBAL'; compactionModel: string }
  | { type: 'SET_COMPACTION_TOKEN_LIMIT_GLOBAL'; limit?: number }
  | { type: 'SET_COMPACTION_TOKEN_LIMIT_FOR_MODEL'; modelId: string; limit?: number }
  | { type: 'SET_LIVE_ENTER_BEHAVIOR'; behavior: LiveEnterBehavior }
  | { type: 'SET_IMAGE_PASTE_QUALITY'; quality: ImagePasteQuality }
  | { type: 'SET_DEFAULT_AUTONOMY'; autonomy: Autonomy }
  | { type: 'SET_DRAFT_AUTONOMY'; autonomy: Autonomy }
  | { type: 'AUTONOMY_UPDATE_REQUESTED'; appSessionId: string; autonomy: Autonomy }
  | { type: 'AUTONOMY_UPDATE_SETTLED'; appSessionId: string };

const defaultTheme: ThemeConfig = {
  mode: 'dark',
  appIconMode: 'system',
  presetId: DEFAULT_THEME_ID,
  accent: '#f2f2f2',
  bg: '#0a0a0a',
  fg: '#ededed',
  surface: '#111111',
  border: '#1f1f1f',
  uiFont: 'system',
  uiFontSize: 14,
  codeFontSize: 12,
  translucentSidebar: false,
  diffStyle: 'soft',
  contrast: 100,
};

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

// Accents that shipped as the old fixed-orange default. A saved theme still
// carrying one of these was never deliberately colored by the user, so migrate
// it to a theme-matched neutral and let the monochrome scale show through.
const LEGACY_DEFAULT_ACCENTS = new Set(['#ee6018', '#ff5d2e']);
const THEME_ACCENT_MIGRATED_KEY = 'droid-theme-accent-migrated';
const THEME_LIGHT_PRESET_MIGRATED_KEY = 'droid-theme-light-preset-migrated';

function neutralAccentFor(bg: string): string {
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return Number.isFinite(lum) && lum >= 0.4 ? '#1a1a1a' : '#f2f2f2';
}

export function normalizeDiffStyle(value: unknown): DiffStyle {
  if (value === 'focused' || value === 'symbol') return 'focused';
  return 'soft';
}

const CUSTOM_THEMES_STORAGE_KEY = 'droid-theme-presets';

function loadCustomThemes(): ThemePreset[] {
  try {
    const raw = getLocalStorage()?.getItem(CUSTOM_THEMES_STORAGE_KEY);
    return raw ? parseCustomThemes(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

// Persistence lives OUTSIDE the reducer: reducers must stay pure, and a throw
// from the root reducer would surface during render and unmount the app. The
// dispatching handler (ThemePresetCard) calls this BEFORE dispatching, so a
// write failure (quota, restricted storage) leaves live state untouched and
// surfaces as a retryable UI error instead of faking success. It throws on
// failure; callers must catch.
export function persistCustomThemes(presets: ThemePreset[]): void {
  getLocalStorage()?.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(presets));
}

// Loaded once at module scope so the theme loader can match saved colors
// against custom presets when recovering a missing presetId.
const initialCustomThemes = loadCustomThemes();

// One-time migration: a saved accent still carrying an old fixed-orange
// default was never deliberately chosen, so neutralize it once. Keying off a
// persisted flag (not the accent value) lets a user later pick that same
// orange from the preset palette and have the choice stick across reloads.
function migrateLegacyAccent(storage: Storage, saved: string | null, theme: ThemeConfig): void {
  if (storage.getItem(THEME_ACCENT_MIGRATED_KEY) === '1') return;
  // Migration writes are isolated so a storage failure (quota/restricted)
  // never discards the theme we already parsed successfully above.
  try {
    if (saved && LEGACY_DEFAULT_ACCENTS.has(theme.accent.toLowerCase())) {
      theme.accent = neutralAccentFor(theme.bg);
      storage.setItem('droid-theme', JSON.stringify(theme));
    }
    storage.setItem(THEME_ACCENT_MIGRATED_KEY, '1');
  } catch {
    /* migration write failed; retry on a later load */
  }
}

// One-time migration: a saved theme still matching the old white-on-white
// light preset exactly was never customized, so swap it to the readable
// warm-grey palette. Same persisted-flag pattern as the accent migration.
function migrateLegacyLight(storage: Storage, saved: string | null, theme: ThemeConfig): void {
  if (storage.getItem(THEME_LIGHT_PRESET_MIGRATED_KEY) === '1') return;
  try {
    if (saved) {
      const migrated = migrateLegacyLightPreset(theme);
      if (migrated !== theme) {
        theme.bg = migrated.bg;
        theme.fg = migrated.fg;
        theme.surface = migrated.surface;
        theme.border = migrated.border;
        theme.accent = migrated.accent;
        storage.setItem('droid-theme', JSON.stringify(theme));
      }
    }
    storage.setItem(THEME_LIGHT_PRESET_MIGRATED_KEY, '1');
  } catch {
    /* migration write failed; retry on a later load */
  }
}

function loadTheme(customThemes: ThemePreset[]): ThemeConfig {
  try {
    const storage = getLocalStorage();
    const saved = storage?.getItem('droid-theme') ?? null;
    const parsed: unknown = saved ? JSON.parse(saved) : null;
    const theme =
      parsed && typeof parsed === 'object'
        ? { ...defaultTheme, ...(parsed as Partial<ThemeConfig>) }
        : { ...defaultTheme };
    theme.diffStyle = normalizeDiffStyle(theme.diffStyle);
    theme.appIconMode = normalizeAppIconMode(theme.appIconMode);
    // Migrations run BEFORE preset detection: a legacy palette migrated onto
    // the default variant must come out with the default's presetId, not
    // 'custom' — otherwise Dark/System can never resolve its other variant.
    if (storage) {
      migrateLegacyAccent(storage, saved, theme);
      migrateLegacyLight(storage, saved, theme);
    }
    // Themes saved before presets existed have no presetId: recover it by
    // matching the saved colors against known variants, else label them custom.
    const savedPresetId = (parsed as { presetId?: unknown } | null)?.presetId;
    theme.presetId =
      typeof savedPresetId === 'string' && savedPresetId
        ? savedPresetId
        : detectPresetId(theme, customThemes);
    return theme;
  } catch {
    /* ignore */
  }
  return defaultTheme;
}

function loadAgentConfig(): AgentConfig {
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

function saveAgentConfig(config: AgentConfig): AgentConfig {
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
const BROWSER_VIEWPORT_MODES = new Set<BrowserViewportMode>([
  'fit',
  'desktop',
  'laptop',
  'tablet',
  'mobile',
  'custom',
]);

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
}

function loadCompactionModel(): string {
  try {
    return getLocalStorage()?.getItem(COMPACTION_MODEL_STORAGE_KEY) || 'current-model';
  } catch {
    return 'current-model';
  }
}

function saveCompactionModel(value: string): string {
  try {
    getLocalStorage()?.setItem(COMPACTION_MODEL_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
  return value;
}

// Compaction token limit persistence and snapshot semantics live in
// lib/compactionSettings.ts; the store only wires them into state changes.

function normalizeLiveEnterBehavior(value: unknown): LiveEnterBehavior {
  return value === 'interrupt' ? 'interrupt' : 'queue';
}

function loadLiveEnterBehavior(): LiveEnterBehavior {
  try {
    return normalizeLiveEnterBehavior(getLocalStorage()?.getItem(LIVE_ENTER_BEHAVIOR_STORAGE_KEY));
  } catch {
    return 'queue';
  }
}

function saveLiveEnterBehavior(value: LiveEnterBehavior): LiveEnterBehavior {
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

function loadImagePasteQuality(): ImagePasteQuality {
  try {
    return normalizeImagePasteQuality(getLocalStorage()?.getItem(IMAGE_PASTE_QUALITY_STORAGE_KEY));
  } catch {
    return 'original';
  }
}

function saveImagePasteQuality(value: ImagePasteQuality): ImagePasteQuality {
  const quality = normalizeImagePasteQuality(value);
  try {
    getLocalStorage()?.setItem(IMAGE_PASTE_QUALITY_STORAGE_KEY, quality);
  } catch {
    /* ignore */
  }
  return quality;
}

function loadDiffView(): DiffViewMode {
  try {
    return getLocalStorage()?.getItem(DIFF_VIEW_STORAGE_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

function saveDiffView(value: DiffViewMode): DiffViewMode {
  const mode = value === 'split' ? 'split' : 'unified';
  try {
    getLocalStorage()?.setItem(DIFF_VIEW_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  return mode;
}

function loadReviewScope(): DiffScope {
  try {
    const raw = getLocalStorage()?.getItem(REVIEW_SCOPE_STORAGE_KEY) as DiffScope | null;
    return raw && DIFF_SCOPES.includes(raw) ? raw : 'unstaged';
  } catch {
    return 'unstaged';
  }
}

function saveReviewScope(value: DiffScope): DiffScope {
  const scope = DIFF_SCOPES.includes(value) ? value : 'unstaged';
  try {
    getLocalStorage()?.setItem(REVIEW_SCOPE_STORAGE_KEY, scope);
  } catch {
    /* ignore */
  }
  return scope;
}

function loadWorkspaceCwds(): string[] {
  try {
    const raw = getLocalStorage()?.getItem(WORKSPACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function saveWorkspaceCwds(cwds: string[]): string[] {
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
    };
  } catch {
    return {};
  }
}

function savePersistedUiState(state: AppState): void {
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
  };
  try {
    getLocalStorage()?.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore */
  }
}

function loadSessionLastSeen(): Record<string, number> {
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

function saveSessionLastSeen(map: Record<string, number>): void {
  try {
    getLocalStorage()?.setItem(SESSION_LAST_SEEN_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function sanitizeAgentConfig(config: AgentConfig, models: ModelInfo[]): AgentConfig {
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

function applySessionOverride(
  summary: SessionSummary,
  override?: { modelId?: string; reasoningEffort?: ReasoningEffort },
): SessionSummary {
  if (!override) return summary;
  const next = { ...summary };
  if ('modelId' in override) next.modelId = override.modelId;
  if (override.reasoningEffort !== undefined) next.reasoningEffort = override.reasoningEffort;
  return next;
}

const persistedUiState = loadPersistedUiState();
const sessionSnapshot = loadSessionSnapshot();

export const initialState: AppState = {
  connection: 'idle',
  sessions: sessionSnapshot?.sessions ?? {},
  sessionOrder: sessionSnapshot?.sessionOrder ?? [],
  listConfirmedSessionIds: sessionSnapshot?.sessionOrder ?? null,
  activeAppSessionId: persistedUiState.activeAppSessionId ?? null,
  sessionLastSeen: loadSessionLastSeen(),
  chatMetadata: loadChatMetadata(),
  transcripts: sessionSnapshot?.transcript
    ? { [sessionSnapshot.transcript.appSessionId]: sessionSnapshot.transcript.events }
    : {},
  transcriptRetainedCost: sessionSnapshot?.transcript
    ? {
        [sessionSnapshot.transcript.appSessionId]: estimateTranscriptCost(
          sessionSnapshot.transcript.events,
        ),
      }
    : {},
  transcriptViewportPinned: {},
  progress: {},
  childSessions: {},
  historyLoaded: {},
  historyCursor: {},
  historyLoadingOlder: {},
  sessionRestore: {},
  childHistory: {},
  childAccess: {},
  childRuntime: {},
  pendingPermissions: {},
  pendingQuestions: {},
  contextStats: { primary: {}, child: {} },
  specPlans: {},
  sessionSpecs: {},
  specWikiAppSessionId: null,
  promptQueue: {},
  sessionNotes: loadSessionNotes(),
  rightPanelOpen: persistedUiState.rightPanelOpen ?? true,
  utilityPanels: persistedUiState.utilityPanels ?? {},
  sidebarCollapsed: persistedUiState.sidebarCollapsed ?? false,
  specMode: persistedUiState.specMode ?? false,
  settingsOpen: false,
  commandPaletteOpen: false,
  theme: loadTheme(initialCustomThemes),
  customThemes: initialCustomThemes,
  missionControlMode: persistedUiState.missionControlMode ?? false,
  draftChat: null,
  defaultAutonomy: loadDefaultAutonomy(),
  draftAutonomy: null,
  pendingAutonomy: {},
  composerSeed: null,
  workspaceCwds: loadWorkspaceCwds(),
  browserOpen: false,
  browserOpenKeys: persistedUiState.browserOpenKeys ?? {},
  browsers: persistedUiState.browsers ?? {},
  browserErrors: {},
  browserGlobalError: undefined,
  designModes: {},
  selectedFeatureId: persistedUiState.selectedFeatureId ?? null,
  selectedChild: null,
  models: [],
  compactionModel: loadCompactionModel(),
  compactionTokenLimit: loadCompactionTokenLimit(),
  compactionTokenLimitPerModel: loadCompactionTokenLimitPerModel(),
  compactionSettingsRev: 0,
  liveEnterBehavior: loadLiveEnterBehavior(),
  imagePasteQuality: loadImagePasteQuality(),
  reviewOpenAppSessionId: null,
  reviewScope: loadReviewScope(),
  reviewFocusPath: null,
  reviewFocusRequestId: 0,
  diffView: loadDiffView(),
  sessionSettingOverrides: {},
  skills: [],
  skillsProviderSessionId: undefined,
  agentConfig: loadAgentConfig(),
  pendingCompose: {},
  lastCreatedSessionRequest: null,
};

function progressKey(entry: ProgressEntry): string {
  return `${entry.timestamp}|${entry.type}|${entry.featureId ?? ''}|${entry.workerChildSessionId ?? ''}|${entry.title ?? ''}`;
}

function activeBrowserKey(state: AppState): string | undefined {
  if (!state.activeAppSessionId) return undefined;
  // Browser state and open-keys are keyed by the stable app session id
  // (`appSessionId`), matching the backend; the provider session is swapped by
  // compaction and would desync the open state from the backend's updates.
  return state.sessions[state.activeAppSessionId]?.appSessionId ?? state.activeAppSessionId;
}

// Record an explicit open (true) or hidden (false) decision for a browser key.
// Storing `false` (rather than deleting) lets data syncs distinguish a pane the
// user deliberately hid from one that was never opened.
function withBrowserOpenKey(
  keys: Record<string, boolean>,
  key: string,
  open: boolean,
): Record<string, boolean> {
  if (keys[key] === open) return keys;
  return { ...keys, [key]: open };
}

// Forget a browser key entirely (full reset, e.g. session closed). A later
// update then treats the session as never-opened.
function clearBrowserOpenKey(keys: Record<string, boolean>, key: string): Record<string, boolean> {
  if (!(key in keys)) return keys;
  const next = { ...keys };
  delete next[key];
  return next;
}

// Re-derive `browserOpen` from the per-session open set and the active session.
// Applied after every reducer pass so the convenience flag never goes stale.
function syncBrowserOpen(state: AppState): AppState {
  const key = activeBrowserKey(state);
  const open = key ? Boolean(state.browserOpenKeys[key]) : false;
  return state.browserOpen === open ? state : { ...state, browserOpen: open };
}

function closeActiveUtilityPanel(state: AppState): AppState {
  const appSessionId = state.activeAppSessionId;
  if (!appSessionId) return state;
  const current = utilityPanelForSession(state.utilityPanels, appSessionId);
  const panel = setUtilityPanelOpen(current, false);
  return panel === current
    ? state
    : { ...state, utilityPanels: { ...state.utilityPanels, [appSessionId]: panel } };
}

function withChildAccess(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
  access: ChildAccess,
): AppState {
  const parent = state.childAccess[parentAppSessionId] ?? {};
  return {
    ...state,
    childAccess: {
      ...state.childAccess,
      [parentAppSessionId]: { ...parent, [childSessionId]: access },
    },
  };
}

function withoutChildAccess(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
): AppState {
  const parent = { ...(state.childAccess[parentAppSessionId] ?? {}) };
  delete parent[childSessionId];
  const childAccess = { ...state.childAccess };
  if (Object.keys(parent).length === 0) delete childAccess[parentAppSessionId];
  else childAccess[parentAppSessionId] = parent;
  return { ...state, childAccess };
}

function withChildRuntime(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
  runtime: ChildRuntimeState,
): AppState {
  const parent = state.childRuntime[parentAppSessionId] ?? {};
  return {
    ...state,
    childRuntime: {
      ...state.childRuntime,
      [parentAppSessionId]: { ...parent, [childSessionId]: runtime },
    },
  };
}

function withChildHistory(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
  history: ChildHistoryState,
): AppState {
  return {
    ...state,
    childHistory: {
      ...state.childHistory,
      [parentAppSessionId]: {
        ...state.childHistory[parentAppSessionId],
        [childSessionId]: history,
      },
    },
  };
}

function releaseInactiveChildTranscript(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
): AppState {
  // These keyed renderer maps are intentionally sparse at runtime despite
  // their long-standing Record types.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  const history = state.childHistory[parentAppSessionId]?.[childSessionId];
  if (history && (!history.isLoaded || !history.isViewportPinned)) return state;
  const child = state.childSessions[parentAppSessionId]?.[childSessionId];
  const runtime = state.childRuntime[parentAppSessionId]?.[childSessionId];
  if (child?.status === 'running' && runtime?.available) return state;
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  return releaseSessionChildTranscriptWindow(
    state,
    parentAppSessionId,
    childSessionId,
    INACTIVE_TRANSCRIPT_POLICY,
  );
}

function releaseInactiveSelectedChild(state: AppState): AppState {
  const selected = state.selectedChild;
  return selected
    ? releaseInactiveChildTranscript(state, selected.parentAppSessionId, selected.childSessionId)
    : state;
}

function invalidateSelectedChildOpening(state: AppState): AppState {
  const selected = state.selectedChild;
  if (!selected) return state;
  const access = state.childAccess[selected.parentAppSessionId]?.[selected.childSessionId];
  return access?.state === 'opening'
    ? withChildAccess(state, selected.parentAppSessionId, selected.childSessionId, {
        state: 'closed',
        requestId: null,
      })
    : state;
}

function withHistoricalCompactionGeneration(
  state: AppState,
  appSessionId: string,
  transcript: TranscriptEvent[],
): AppState {
  const session = state.sessions[appSessionId];
  if (!session) return state;

  const compactionMarkers = transcript.filter(
    (event) => event.kind === 'compaction' && event.role === 'primary',
  );
  const restoredCompactions = Math.max(
    compactionMarkers.filter((event) => event.id.startsWith('compaction-')).length,
    compactionMarkers.filter((event) => !event.id.startsWith('compaction-')).length,
  );
  const currentCompactions = session.autoCompactions ?? 0;
  if (restoredCompactions <= currentCompactions) return state;

  const primaryContext = Object.fromEntries(
    Object.entries(state.contextStats.primary).filter(([id]) => id !== appSessionId),
  );
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [appSessionId]: {
        ...session,
        autoCompactions: restoredCompactions,
        contextTokens: 0,
        contextRemainingTokens: undefined,
        contextAccuracy: undefined,
        contextUpdatedAt: undefined,
      },
    },
    contextStats: { ...state.contextStats, primary: primaryContext },
  };
}

export function reducer(state: AppState, action: Action): AppState {
  if (action.type === 'BATCH') {
    return action.actions.reduce(reducer, state);
  }
  return syncBrowserOpen(baseReducer(state, action));
}

function baseReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_CONNECTION': {
      if (action.status === 'connected')
        return { ...state, connection: action.status, connectionError: action.message };
      const next = invalidateSelectedChildOpening(state);
      return {
        ...next,
        connection: action.status,
        connectionError: action.message,
        selectedChild: null,
        childAccess: {},
        childRuntime: {},
        contextStats: { ...next.contextStats, child: {} },
      };
    }

    case 'SESSION_CREATED': {
      const pending = state.pendingCompose[action.clientRef];
      // `session.created` is also emitted when an existing session resumes.
      // Only a create matching this renderer's pending compose may take focus;
      // background resumes must never replace the chat the user selected.
      const shouldActivate = pending !== undefined;
      const targetIsActive = state.activeAppSessionId === action.session.appSessionId;
      const childReset =
        shouldActivate || targetIsActive ? invalidateSelectedChildOpening(state) : state;
      const childAccess = { ...childReset.childAccess };
      const childRuntime = { ...childReset.childRuntime };
      delete childAccess[action.session.appSessionId];
      delete childRuntime[action.session.appSessionId];
      const order = state.sessionOrder.includes(action.session.appSessionId)
        ? state.sessionOrder
        : [action.session.appSessionId, ...state.sessionOrder];

      // Seed the first user message: the goal is the user's opening prompt and the
      // backend never echoes it back, so without this the first message never shows.
      let transcripts = state.transcripts;
      let transcriptRetainedCost = state.transcriptRetainedCost;
      const hasTranscript = (state.transcripts[action.session.appSessionId]?.length ?? 0) > 0;
      if (action.session.goal && !hasTranscript) {
        const seed: TranscriptEvent = {
          id: `seed-${action.session.appSessionId}`,
          appSessionId: action.session.appSessionId,
          sourceSessionId: 'user',
          role: 'primary',
          ts: action.session.createdAt || Date.now(),
          kind: 'text',
          text: pending ? pending.text : action.session.goal,
          author: 'user',
          skills: pending?.skills.length ? pending.skills : undefined,
          files: pending?.files.length ? pending.files : undefined,
        };
        transcripts = { ...state.transcripts, [action.session.appSessionId]: [seed] };
        transcriptRetainedCost = {
          ...state.transcriptRetainedCost,
          [action.session.appSessionId]: estimateTranscriptCost([seed]),
        };
      }

      const pendingCompose = pending
        ? Object.fromEntries(
            Object.entries(state.pendingCompose).filter(([k]) => k !== action.clientRef),
          )
        : state.pendingCompose;

      const next = {
        ...childReset,
        sessions: {
          ...state.sessions,
          [action.session.appSessionId]: applySessionOverride(
            action.session,
            state.sessionSettingOverrides[action.session.appSessionId],
          ),
        },
        sessionOrder: order,
        transcripts,
        transcriptRetainedCost,
        activeAppSessionId: shouldActivate ? action.session.appSessionId : state.activeAppSessionId,
        draftChat: shouldActivate ? null : state.draftChat,
        draftAutonomy: shouldActivate ? null : state.draftAutonomy,
        selectedChild: shouldActivate || targetIsActive ? null : childReset.selectedChild,
        // A pending review-focus request belongs to the session that issued
        // it; a different session becoming active must not inherit it.
        reviewFocusPath:
          shouldActivate && action.session.appSessionId !== state.activeAppSessionId
            ? null
            : state.reviewFocusPath,
        childAccess,
        childRuntime,
        pendingCompose,
        lastCreatedSessionRequest: shouldActivate
          ? { clientRef: action.clientRef, appSessionId: action.session.appSessionId }
          : state.lastCreatedSessionRequest,
        // A foreground chat just created by this renderer is already seen.
        sessionLastSeen: shouldActivate
          ? {
              ...state.sessionLastSeen,
              [action.session.appSessionId]: action.session.updatedAt,
            }
          : state.sessionLastSeen,
      };
      return next;
    }

    case 'SET_PENDING_COMPOSE':
      return {
        ...state,
        pendingCompose: {
          ...state.pendingCompose,
          [action.clientRef]: { text: action.text, skills: action.skills, files: action.files },
        },
      };

    case 'SESSION_UPDATED': {
      const previous = state.sessions[action.session.appSessionId];
      const incoming = applySessionOverride(
        action.session,
        state.sessionSettingOverrides[action.session.appSessionId],
      );
      // Compaction generations are monotonic. A delayed resume summary must not
      // put a restored session back on generation zero after history already
      // proved that compactions occurred.
      const m =
        previous && (previous.autoCompactions ?? 0) > (incoming.autoCompactions ?? 0)
          ? {
              ...incoming,
              autoCompactions: previous.autoCompactions,
              contextTokens: previous.contextTokens,
              contextRemainingTokens: previous.contextRemainingTokens,
              contextAccuracy: previous.contextAccuracy,
              contextUpdatedAt: previous.contextUpdatedAt,
            }
          : incoming;
      const previousCompactions =
        (previous?.compactedFromProviderSessionIds?.length ?? 0) + (previous?.autoCompactions ?? 0);
      const nextCompactions =
        (m.compactedFromProviderSessionIds?.length ?? 0) + (m.autoCompactions ?? 0);
      const contextStats =
        nextCompactions > previousCompactions
          ? {
              ...state.contextStats,
              primary: Object.fromEntries(
                Object.entries(state.contextStats.primary).filter(
                  ([appSessionId]) => appSessionId !== m.appSessionId,
                ),
              ),
            }
          : state.contextStats;
      // A pending autonomy change settles when the confirmed summary reaches
      // the requested level, or when the level changed through another path.
      const requestedAutonomy =
        m.appSessionId in state.pendingAutonomy ? state.pendingAutonomy[m.appSessionId] : undefined;
      const autonomySettled =
        requestedAutonomy !== undefined &&
        (m.autonomy === requestedAutonomy ||
          (m.appSessionId in state.sessions && m.autonomy !== previous.autonomy));
      const pendingAutonomy = autonomySettled
        ? Object.fromEntries(
            Object.entries(state.pendingAutonomy).filter(([id]) => id !== m.appSessionId),
          )
        : state.pendingAutonomy;
      const next = {
        ...state,
        sessions: { ...state.sessions, [m.appSessionId]: m },
        contextStats,
        pendingAutonomy,
      };
      if (
        !previous ||
        !sessionIsLive(previous) ||
        sessionIsLive(m) ||
        m.updatedAt <= previous.updatedAt ||
        state.activeAppSessionId === m.appSessionId ||
        state.transcriptViewportPinned[m.appSessionId] === false
      )
        return next;
      return releaseSessionTranscriptWindow(next, m.appSessionId, INACTIVE_TRANSCRIPT_POLICY);
    }

    case 'SESSION_CLOSED': {
      const childAccess = { ...state.childAccess };
      const childRuntime = { ...state.childRuntime };
      const childContext = { ...state.contextStats.child };
      delete childAccess[action.appSessionId];
      delete childRuntime[action.appSessionId];
      delete childContext[action.appSessionId];
      return {
        ...state,
        childAccess,
        childRuntime,
        pendingPermissions: Object.fromEntries(
          Object.entries(state.pendingPermissions).filter(([id]) => id !== action.appSessionId),
        ),
        pendingQuestions: Object.fromEntries(
          Object.entries(state.pendingQuestions).filter(([id]) => id !== action.appSessionId),
        ),
        contextStats: { ...state.contextStats, child: childContext },
        pendingAutonomy: Object.fromEntries(
          Object.entries(state.pendingAutonomy).filter(([id]) => id !== action.appSessionId),
        ),
        selectedChild:
          state.selectedChild?.parentAppSessionId === action.appSessionId
            ? null
            : state.selectedChild,
      };
    }

    // Chat organization transforms return null for no-ops so these cases keep
    // the current state untouched (no re-render, no storage write).
    case 'RENAME_CHAT': {
      const chatMetadata = renameChat(state.chatMetadata, action.appSessionId, action.title);
      return chatMetadata ? { ...state, chatMetadata } : state;
    }

    case 'PIN_CHAT': {
      const chatMetadata = pinChat(state.chatMetadata, action.appSessionId, Date.now());
      return chatMetadata ? { ...state, chatMetadata } : state;
    }

    case 'UNPIN_CHAT': {
      const chatMetadata = unpinChat(state.chatMetadata, action.appSessionId);
      return chatMetadata ? { ...state, chatMetadata } : state;
    }

    case 'ARCHIVE_CHAT': {
      const chatMetadata = archiveChat(state.chatMetadata, action.appSessionId, Date.now());
      return chatMetadata ? { ...state, chatMetadata } : state;
    }

    case 'RESTORE_CHAT': {
      const chatMetadata = restoreChat(state.chatMetadata, action.appSessionId);
      return chatMetadata ? { ...state, chatMetadata } : state;
    }

    case 'DELETE_CHAT': {
      const chatMetadata = deleteChat(state.chatMetadata, action.appSessionId, Date.now());
      return chatMetadata ? { ...state, chatMetadata } : state;
    }

    case 'SESSION_FEATURES': {
      const mid = action.appSessionId;
      const existing = state.sessions[mid];
      if (!existing) return state;
      return {
        ...state,
        sessions: { ...state.sessions, [mid]: { ...existing, features: action.features } },
      };
    }

    case 'SESSION_PROGRESS': {
      const mid = action.appSessionId;
      const prev = state.progress[mid] ?? [];
      const seen = new Set(prev.map(progressKey));
      const next = [...prev];
      action.entries.forEach((entry) => {
        const key = progressKey(entry);
        if (seen.has(key)) return;
        seen.add(key);
        next.push(entry);
      });
      return {
        ...state,
        progress: { ...state.progress, [mid]: next },
      };
    }

    case 'SESSION_CHILD': {
      const child = action.child;
      const parent = state.childSessions[child.parentAppSessionId] ?? {};
      const previousChild = parent[child.childSessionId];
      const runtimeParent = state.childRuntime[child.parentAppSessionId] ?? {};
      const previousRuntime = runtimeParent[child.childSessionId];
      if (previousRuntime && action.runtimeGeneration < previousRuntime.runtimeGeneration)
        return state;
      const settledWhileInactive =
        previousChild?.status === 'running' &&
        previousRuntime?.available &&
        (child.status !== 'running' || !action.runtimeAvailable) &&
        (state.activeAppSessionId !== child.parentAppSessionId ||
          state.selectedChild?.parentAppSessionId !== child.parentAppSessionId ||
          state.selectedChild.childSessionId !== child.childSessionId);
      const clearContext =
        !action.runtimeAvailable ||
        (previousRuntime !== undefined &&
          action.runtimeGeneration > previousRuntime.runtimeGeneration);
      const contextParent = state.contextStats.child[child.parentAppSessionId] ?? {};
      let next = {
        ...state,
        childSessions: {
          ...state.childSessions,
          [child.parentAppSessionId]: {
            ...parent,
            [child.childSessionId]: child,
          },
        },
        contextStats: clearContext
          ? {
              ...state.contextStats,
              child: {
                ...state.contextStats.child,
                [child.parentAppSessionId]: Object.fromEntries(
                  Object.entries(contextParent).filter(
                    ([childSessionId]) => childSessionId !== child.childSessionId,
                  ),
                ),
              },
            }
          : state.contextStats,
      };
      const runtimeUnchanged =
        // Keep the existence guard because the following comparison dereferences previousRuntime.
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
        previousRuntime &&
        action.runtimeGeneration === previousRuntime.runtimeGeneration &&
        action.runtimeAvailable === previousRuntime.available;
      if (!runtimeUnchanged) {
        next = {
          ...next,
          childRuntime: {
            ...state.childRuntime,
            [child.parentAppSessionId]: {
              ...runtimeParent,
              [child.childSessionId]: {
                available: action.runtimeAvailable,
                runtimeGeneration: action.runtimeGeneration,
              },
            },
          },
        };
        const access = state.childAccess[child.parentAppSessionId]?.[child.childSessionId];
        if (!action.runtimeAvailable && (access?.state === 'opening' || access?.state === 'ready'))
          next = withChildAccess(next, child.parentAppSessionId, child.childSessionId, {
            state: 'closed',
            requestId: null,
          });
        else if (action.runtimeAvailable && access?.state === 'ready')
          next = withChildAccess(next, child.parentAppSessionId, child.childSessionId, {
            ...access,
            runtimeGeneration: action.runtimeGeneration,
          });
      }
      return settledWhileInactive
        ? releaseInactiveChildTranscript(next, child.parentAppSessionId, child.childSessionId)
        : next;
    }

    case 'CHILD_UPDATED': {
      if (
        state.selectedChild?.parentAppSessionId !== action.parentAppSessionId ||
        state.selectedChild.childSessionId !== action.childSessionId
      )
        return state;
      const current = state.childAccess[action.parentAppSessionId]?.[action.childSessionId];
      if (current?.state !== 'opening' || current.requestId !== action.requestId) return state;
      const runtime = state.childRuntime[action.parentAppSessionId]?.[action.childSessionId];
      if (
        action.access === 'ready' &&
        runtime &&
        (action.runtimeGeneration < runtime.runtimeGeneration ||
          (action.runtimeGeneration === runtime.runtimeGeneration && !runtime.available))
      )
        return state;
      const settled = withChildAccess(
        state,
        action.parentAppSessionId,
        action.childSessionId,
        action.access === 'ready'
          ? {
              state: 'ready',
              requestId: action.requestId,
              runtimeGeneration: action.runtimeGeneration,
            }
          : { state: 'history', requestId: action.requestId },
      );
      return action.access === 'ready'
        ? withChildRuntime(settled, action.parentAppSessionId, action.childSessionId, {
            available: true,
            runtimeGeneration: action.runtimeGeneration,
          })
        : settled;
    }

    case 'CHILD_ERROR': {
      if (action.operation === 'loadHistory') {
        /* eslint-disable @typescript-eslint/no-unnecessary-condition -- sparse keyed renderer maps */
        const previous = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
        const next = withChildHistory(state, action.parentAppSessionId, action.childSessionId, {
          status: 'failed',
          loadedCount: previous?.loadedCount ?? 0,
          hasMore: previous?.hasMore ?? false,
          error: action.message,
          isLoaded: previous?.isLoaded ?? false,
          isLoadingOlder: false,
          olderCursor: previous?.olderCursor,
          isViewportPinned: previous?.isViewportPinned ?? true,
        });
        /* eslint-enable @typescript-eslint/no-unnecessary-condition */
        return next;
      }
      if (action.operation !== 'open' || !action.requestId) return state;
      if (
        state.selectedChild?.parentAppSessionId !== action.parentAppSessionId ||
        state.selectedChild.childSessionId !== action.childSessionId
      )
        return state;
      const current = state.childAccess[action.parentAppSessionId]?.[action.childSessionId];
      if (current?.state !== 'opening' || current.requestId !== action.requestId) return state;
      return withChildAccess(state, action.parentAppSessionId, action.childSessionId, {
        state: 'failed',
        requestId: action.requestId,
      });
    }

    case 'SESSION_TOKENS': {
      const mid = action.appSessionId;
      const existing = state.sessions[mid];
      if (!existing) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [mid]: {
            ...existing,
            tokensIn: action.tokensIn,
            tokensOut: action.tokensOut,
            contextTokens: action.contextTokens,
            maxContextTokens: action.maxContextTokens ?? existing.maxContextTokens,
          },
        },
      };
    }

    case 'CONTEXT_UPDATED': {
      const existing = state.sessions[action.appSessionId];
      if (action.parentAppSessionId && action.childSessionId) {
        const parent = state.contextStats.child[action.parentAppSessionId] ?? {};
        return {
          ...state,
          contextStats: {
            ...state.contextStats,
            child: {
              ...state.contextStats.child,
              [action.parentAppSessionId]: {
                ...parent,
                [action.childSessionId]: action.stats,
              },
            },
          },
        };
      }
      return {
        ...state,
        contextStats: {
          ...state.contextStats,
          primary: { ...state.contextStats.primary, [action.appSessionId]: action.stats },
        },
        sessions: existing
          ? {
              ...state.sessions,
              [action.appSessionId]: {
                ...existing,
                contextTokens: action.stats.used,
                contextRemainingTokens: action.stats.remaining,
                maxContextTokens: action.stats.limit,
                contextAccuracy: action.stats.accuracy,
                contextUpdatedAt: action.stats.updatedAt,
              },
            }
          : state.sessions,
      };
    }

    case 'SESSION_TRANSCRIPT':
      return appendTranscriptEvent(state, action.event);

    case 'TRANSCRIPT_VIEWPORT':
      return state.transcriptViewportPinned[action.appSessionId] === action.pinned
        ? state
        : {
            ...state,
            transcriptViewportPinned: {
              ...state.transcriptViewportPinned,
              [action.appSessionId]: action.pinned,
            },
          };

    /* eslint-disable @typescript-eslint/no-unnecessary-condition -- sparse keyed renderer maps */
    case 'TRANSCRIPT_RELEASE_VIEWPORT': {
      if (state.activeAppSessionId !== action.appSessionId) return state;
      if (state.transcriptViewportPinned[action.appSessionId] === false) return state;
      const session = state.sessions[action.appSessionId];
      if (!session || sessionIsLive(session)) return state;
      return releaseSessionTranscriptWindow(state, action.appSessionId, VIEWPORT_TRANSCRIPT_POLICY);
    }

    case 'CHILD_TRANSCRIPT_VIEWPORT': {
      const previous = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
      if (!previous || previous.isViewportPinned === action.pinned) return state;
      return {
        ...state,
        childHistory: {
          ...state.childHistory,
          [action.parentAppSessionId]: {
            ...state.childHistory[action.parentAppSessionId],
            [action.childSessionId]: {
              ...previous,
              isViewportPinned: action.pinned,
            },
          },
        },
      };
    }

    case 'CHILD_TRANSCRIPT_RELEASE_VIEWPORT': {
      if (
        state.activeAppSessionId !== action.parentAppSessionId ||
        state.selectedChild?.parentAppSessionId !== action.parentAppSessionId ||
        state.selectedChild.childSessionId !== action.childSessionId
      ) {
        return state;
      }
      const history = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
      if (!history?.isLoaded || !history.isViewportPinned) return state;
      const child = state.childSessions[action.parentAppSessionId]?.[action.childSessionId];
      const runtime = state.childRuntime[action.parentAppSessionId]?.[action.childSessionId];
      if (child?.status === 'running' && runtime?.available) return state;
      return releaseSessionChildTranscriptWindow(
        state,
        action.parentAppSessionId,
        action.childSessionId,
        VIEWPORT_TRANSCRIPT_POLICY,
      );
    }
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */

    case 'QUEUE_PROMPT': {
      const prev = state.promptQueue[action.appSessionId] ?? [];
      return {
        ...state,
        promptQueue: { ...state.promptQueue, [action.appSessionId]: [...prev, action.prompt] },
      };
    }

    case 'REMOVE_QUEUED_PROMPT': {
      const prev = state.promptQueue[action.appSessionId] ?? [];
      return {
        ...state,
        promptQueue: {
          ...state.promptQueue,
          [action.appSessionId]: prev.filter((p) => p.id !== action.id),
        },
      };
    }

    case 'REORDER_QUEUE': {
      const prev = state.promptQueue[action.appSessionId] ?? [];
      if (
        action.from === action.to ||
        action.from < 0 ||
        action.to < 0 ||
        action.from >= prev.length ||
        action.to >= prev.length
      ) {
        return state;
      }
      const next = [...prev];
      const [moved] = next.splice(action.from, 1);
      next.splice(action.to, 0, moved);
      return { ...state, promptQueue: { ...state.promptQueue, [action.appSessionId]: next } };
    }

    case 'SPEC_SET': {
      const prev = state.sessionSpecs[action.appSessionId];
      if (
        // Keep the existence guard because the following comparisons dereference prev.
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
        prev &&
        prev.content === action.content &&
        prev.path === action.path &&
        prev.title === action.title
      ) {
        return state;
      }
      return {
        ...state,
        sessionSpecs: {
          ...state.sessionSpecs,
          [action.appSessionId]: {
            path: action.path,
            title: action.title,
            content: action.content,
          },
        },
      };
    }

    case 'SPEC_OPEN_WIKI':
      return { ...state, specWikiAppSessionId: action.appSessionId };

    case 'SPEC_CLOSE_WIKI':
      return { ...state, specWikiAppSessionId: null };

    case 'SESSION_PERMISSION': {
      const r = action.request;
      const specPlans =
        r.kind === 'spec' && r.plan
          ? { ...state.specPlans, [r.appSessionId]: r.plan }
          : state.specPlans;
      // Seed the persistent spec/plan so the inline card and wiki reader work
      // immediately (a richer spec file, if any, overrides this via SPEC_SET).
      // Seed/refresh the persistent spec whenever a (revised) plan arrives so the
      // card/wiki never go stale. The path is preserved; ChatView reloads the
      // file on revision and overrides with the richer on-disk content.
      const existingSpec = state.sessionSpecs[r.appSessionId];
      const sessionSpecs =
        (r.kind === 'spec' || r.kind === 'mission_plan') &&
        r.plan &&
        existingSpec?.content !== r.plan
          ? {
              ...state.sessionSpecs,
              [r.appSessionId]: { path: existingSpec?.path, title: r.title, content: r.plan },
            }
          : state.sessionSpecs;
      return {
        ...state,
        pendingPermissions: { ...state.pendingPermissions, [r.appSessionId]: r },
        specPlans,
        sessionSpecs,
      };
    }

    case 'SESSION_QUESTION':
      return {
        ...state,
        pendingQuestions: {
          ...state.pendingQuestions,
          [action.question.appSessionId]: action.question,
        },
      };

    case 'SESSION_CREATE_FAILED':
      return {
        ...state,
        pendingCompose: Object.fromEntries(
          Object.entries(state.pendingCompose).filter(
            ([clientRef]) => clientRef !== action.clientRef,
          ),
        ),
        lastCreatedSessionRequest:
          state.lastCreatedSessionRequest?.clientRef === action.clientRef
            ? null
            : state.lastCreatedSessionRequest,
      };

    case 'SESSION_ERROR': {
      let next = state;
      if (action.appSessionId && state.sessions[action.appSessionId]) {
        const m = state.sessions[action.appSessionId];
        next = {
          ...state,
          sessions: {
            ...state.sessions,
            [action.appSessionId]: { ...m, phase: 'failed' as const },
          },
        };
      }
      return next;
    }

    case 'SESSION_LIST': {
      const incoming = new Set(action.sessions.map((m) => m.appSessionId));
      // Every list is a fresh scan of what exists, so it is authoritative for
      // the rows the previous listing confirmed: drop confirmed rows it no
      // longer reports (deleted outside the app, or pruned from a hydrated
      // snapshot). Rows added locally this run are not confirmed yet and
      // survive.
      const confirmed = state.listConfirmedSessionIds;
      const map: Record<string, SessionSummary> = {};
      for (const [id, summary] of Object.entries(state.sessions)) {
        if (confirmed?.includes(id) && !incoming.has(id)) continue;
        map[id] = summary;
      }
      for (const m of action.sessions) {
        map[m.appSessionId] = applySessionOverride(
          m,
          state.sessionSettingOverrides[m.appSessionId],
        );
      }
      const order = [
        ...new Set([
          ...action.sessions.map((m) => m.appSessionId),
          ...state.sessionOrder,
          ...Object.keys(state.sessions),
        ]),
      ]
        .filter((id) => map[id])
        .sort((a, b) => map[b].updatedAt - map[a].updatedAt);
      const retainedSessionIds = new Set(Object.keys(map));
      const retainedState = pruneRemovedSessionState(state, retainedSessionIds);
      // Seed last-seen for sessions this client has never tracked so existing
      // history is not retroactively marked unread; only activity that arrives
      // after this point (a newer updatedAt) flips a row to unread.
      const seededLastSeen = { ...retainedState.sessionLastSeen };
      for (const m of action.sessions) {
        if (seededLastSeen[m.appSessionId] === undefined) {
          seededLastSeen[m.appSessionId] = m.updatedAt;
        }
      }
      // If the active session was pruned above (a hydrated snapshot row the
      // sidecar no longer reports), clear the dangling id so the UI does not
      // point at a session that no longer exists.
      const mapById: Partial<Record<string, SessionSummary>> = map;
      const activeAppSessionId =
        state.activeAppSessionId !== null && mapById[state.activeAppSessionId] !== undefined
          ? state.activeAppSessionId
          : null;
      // Prune pin/archive metadata for the same confirmed-gone rows so
      // localStorage does not accumulate orphans. Metadata for rows added
      // locally this run (not yet list-confirmed) survives.
      let chatMetadata = state.chatMetadata;
      const orphaned = Object.keys(chatMetadata).filter(
        (id) => confirmed?.includes(id) && !incoming.has(id),
      );
      if (orphaned.length > 0) {
        const drop = new Set(orphaned);
        chatMetadata = Object.fromEntries(
          Object.entries(chatMetadata).filter(([id]) => !drop.has(id)),
        );
      }
      return {
        ...retainedState,
        sessions: map,
        sessionOrder: order,
        sessionLastSeen: seededLastSeen,
        chatMetadata,
        listConfirmedSessionIds: action.sessions.map((m) => m.appSessionId),
        activeAppSessionId,
      };
    }

    case 'SESSION_HISTORY_LOADING_OLDER':
      return {
        ...state,
        historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: true },
      };

    /* eslint-disable @typescript-eslint/no-unnecessary-condition -- sparse keyed renderer maps */
    case 'CHILD_HISTORY_LOADING': {
      const previous = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
      return withChildHistory(state, action.parentAppSessionId, action.childSessionId, {
        status: 'loading',
        loadedCount: previous?.loadedCount ?? 0,
        hasMore: previous?.hasMore ?? false,
        isLoaded: false,
        isLoadingOlder: false,
        olderCursor: undefined,
        isViewportPinned: previous?.isViewportPinned ?? true,
      });
    }

    case 'CHILD_HISTORY_LOADING_OLDER': {
      const previous = state.childHistory[action.parentAppSessionId]?.[action.childSessionId];
      if (!previous || previous.isLoadingOlder) return state;
      return withChildHistory(state, action.parentAppSessionId, action.childSessionId, {
        ...previous,
        isLoadingOlder: true,
      });
    }

    case 'SESSION_RESTORE_START': {
      const prev = state.sessionRestore[action.appSessionId];
      return {
        ...state,
        sessionRestore: {
          ...state.sessionRestore,
          [action.appSessionId]: {
            status: 'loading',
            loadedCount: prev?.loadedCount ?? 0,
            hasMore: prev?.hasMore ?? false,
          },
        },
      };
    }

    case 'SESSION_HISTORY_FAILED': {
      if (action.childSessionId) {
        const prev = state.childHistory[action.appSessionId]?.[action.childSessionId];
        return withChildHistory(state, action.appSessionId, action.childSessionId, {
          status: 'failed',
          loadedCount: prev?.loadedCount ?? 0,
          hasMore: prev?.hasMore ?? false,
          error: action.message,
          isLoaded: prev?.isLoaded ?? false,
          isLoadingOlder: false,
          olderCursor: prev?.olderCursor,
          isViewportPinned: prev?.isViewportPinned ?? true,
        });
      }
      const prev = state.sessionRestore[action.appSessionId];
      return {
        ...state,
        historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: false },
        sessionRestore: {
          ...state.sessionRestore,
          [action.appSessionId]: {
            status: 'failed',
            loadedCount: prev?.loadedCount ?? 0,
            hasMore: prev?.hasMore ?? false,
            error: action.message,
          },
        },
      };
    }

    case 'SESSION_HISTORY': {
      const existing = state.transcripts[action.appSessionId] ?? [];
      const hasMore = Boolean(action.olderCursor);

      if (action.childSessionId) {
        const reconciled = reconcileTranscriptSourcePage(
          existing,
          action.childSessionId,
          action.transcripts,
          action.mode ?? 'replace',
          hasMore,
        );
        const transcriptChanged = reconciled.transcript !== existing;
        const previousHistory = state.childHistory[action.appSessionId]?.[action.childSessionId];
        const historyState = withChildHistory(state, action.appSessionId, action.childSessionId, {
          status: hasMore ? 'paged' : 'loaded',
          loadedCount: reconciled.sourceEvents.length,
          hasMore,
          isLoaded: true,
          isLoadingOlder: false,
          olderCursor: action.olderCursor,
          isViewportPinned: previousHistory?.isViewportPinned ?? true,
        });
        const next = transcriptChanged
          ? withUpdatedTranscript(
              historyState,
              action.appSessionId,
              reconciled.transcript,
              estimateTranscriptCost(reconciled.transcript),
              action.childSessionId,
            )
          : historyState;
        const isSelected =
          next.selectedChild?.parentAppSessionId === action.appSessionId &&
          next.selectedChild.childSessionId === action.childSessionId;
        return isSelected
          ? next
          : releaseInactiveChildTranscript(next, action.appSessionId, action.childSessionId);
      }

      if (action.mode === 'prepend') {
        const mergedTranscript = reconcilePrependedTranscript(existing, action.transcripts);
        const transcriptChanged = mergedTranscript !== existing;
        const historyState: AppState = {
          ...state,
          historyCursor: { ...state.historyCursor, [action.appSessionId]: action.olderCursor },
          historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: false },
          sessionRestore: {
            ...state.sessionRestore,
            [action.appSessionId]: {
              status: hasMore ? 'paged' : 'loaded',
              loadedCount: mergedTranscript.length,
              hasMore,
            },
          },
        };
        const next = transcriptChanged
          ? withUpdatedTranscript(
              historyState,
              action.appSessionId,
              mergedTranscript,
              estimateTranscriptCost(mergedTranscript),
            )
          : historyState;
        return withHistoricalCompactionGeneration(next, action.appSessionId, mergedTranscript);
      }

      const mergedTranscript = reconcileRestoredTranscript(existing, action.transcripts, !hasMore);
      const transcriptChanged = mergedTranscript !== existing;
      const historicalChildren = action.childSessions ?? [];
      const existingChildSessions = state.childSessions[action.appSessionId] ?? {};
      let childSessions = state.childSessions;
      if (historicalChildren.length > 0) {
        const byChild = { ...existingChildSessions };
        for (const child of historicalChildren)
          byChild[child.childSessionId] = byChild[child.childSessionId] ?? child;
        childSessions = {
          ...state.childSessions,
          [action.appSessionId]: byChild,
        };
      }
      // An empty restore (e.g. a live session with no persisted history yet)
      // must not wipe progress already delivered by live events; only adopt the
      // replayed progress when it actually carries entries.
      const existingProgress = state.progress[action.appSessionId] ?? [];
      const mergedProgress = action.progress.length > 0 ? action.progress : existingProgress;
      const historyState: AppState = {
        ...state,
        progress: { ...state.progress, [action.appSessionId]: mergedProgress },
        childSessions,
        historyLoaded: { ...state.historyLoaded, [action.appSessionId]: true },
        historyCursor: { ...state.historyCursor, [action.appSessionId]: action.olderCursor },
        historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: false },
        sessionRestore: {
          ...state.sessionRestore,
          [action.appSessionId]: {
            status: hasMore ? 'paged' : 'loaded',
            loadedCount: mergedTranscript.length,
            hasMore,
          },
        },
      };
      const next = transcriptChanged
        ? withUpdatedTranscript(
            historyState,
            action.appSessionId,
            mergedTranscript,
            estimateTranscriptCost(mergedTranscript),
          )
        : historyState;
      return withHistoricalCompactionGeneration(next, action.appSessionId, mergedTranscript);
    }
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */

    case 'CLEAR_PERMISSION': {
      return {
        ...state,
        pendingPermissions: Object.fromEntries(
          Object.entries(state.pendingPermissions).filter(([id]) => id !== action.appSessionId),
        ),
      };
    }

    case 'CLEAR_QUESTION': {
      return {
        ...state,
        pendingQuestions: Object.fromEntries(
          Object.entries(state.pendingQuestions).filter(([id]) => id !== action.appSessionId),
        ),
      };
    }

    case 'SET_ACTIVE_SESSION': {
      // Stamp "seen now" on both the session being left (so responses received
      // while it was open count as read) and the one being opened (clears its
      // unread state immediately).
      const now = Date.now();
      const sessionLastSeen = { ...state.sessionLastSeen };
      if (state.activeAppSessionId && state.sessions[state.activeAppSessionId]) {
        sessionLastSeen[state.activeAppSessionId] = now;
      }
      if (action.id) sessionLastSeen[action.id] = now;
      let next = invalidateSelectedChildOpening(releaseInactiveSelectedChild(state));
      const outgoingAppSessionId = state.activeAppSessionId;
      const outgoingSession = outgoingAppSessionId
        ? state.sessions[outgoingAppSessionId]
        : undefined;
      if (
        outgoingAppSessionId &&
        outgoingAppSessionId !== action.id &&
        outgoingSession &&
        !sessionIsLive(outgoingSession) &&
        state.transcriptViewportPinned[outgoingAppSessionId] !== false
      ) {
        next = releaseSessionTranscriptWindow(
          next,
          outgoingAppSessionId,
          INACTIVE_TRANSCRIPT_POLICY,
        );
      }
      return {
        ...next,
        activeAppSessionId: action.id,
        sessionLastSeen,
        draftChat: null,
        draftAutonomy: null,
        selectedChild: null,
        // A pending review-focus request belongs to the session that issued
        // it; never let it fire in another session's panel after a switch.
        reviewFocusPath: action.id === state.activeAppSessionId ? state.reviewFocusPath : null,
      };
    }

    case 'MARK_ALL_SESSIONS_READ': {
      const sessionLastSeen = { ...state.sessionLastSeen };
      let changed = false;
      for (const appSessionId of state.sessionOrder) {
        const session = state.sessions[appSessionId];
        // Persisted renderer state can briefly contain an order entry whose
        // session was already removed.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!session) continue;
        const seenAt = Math.max(action.seenAt, session.updatedAt);
        if (sessionLastSeen[appSessionId] === seenAt) continue;
        sessionLastSeen[appSessionId] = seenAt;
        changed = true;
      }
      return changed ? { ...state, sessionLastSeen } : state;
    }

    case 'SET_RIGHT_PANEL':
      return action.open
        ? closeActiveUtilityPanel({ ...state, rightPanelOpen: true })
        : { ...state, rightPanelOpen: false };

    case 'OPEN_UTILITY_TOOL': {
      const appSessionId = state.activeAppSessionId;
      if (!appSessionId) return state;
      const panel = openUtilityTool(
        state.utilityPanels[appSessionId],
        action.tool,
        () => action.tabId ?? `${action.tool}:${appSessionId}`,
        { terminalId: action.terminalId, cwd: action.cwd, filePath: action.filePath },
      );
      return {
        ...state,
        rightPanelOpen: false,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
        reviewOpenAppSessionId:
          action.tool === 'review' ? appSessionId : state.reviewOpenAppSessionId,
        browserOpenKeys:
          action.tool === 'browser'
            ? withBrowserOpenKey(state.browserOpenKeys, appSessionId, true)
            : state.browserOpenKeys,
      };
    }

    case 'CLOSE_UTILITY_TAB': {
      const appSessionId = action.appSessionId ?? state.activeAppSessionId;
      if (!appSessionId) return state;
      const current = state.utilityPanels[appSessionId];
      const closing = current?.tabs.find((tab) => tab.id === action.tabId);
      const panel = closeUtilityTab(current, action.tabId);
      if (panel === current) return state;
      return {
        ...state,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
        reviewOpenAppSessionId:
          closing?.tool === 'review' && state.reviewOpenAppSessionId === appSessionId
            ? null
            : state.reviewOpenAppSessionId,
        reviewFocusPath: closing?.tool === 'review' ? null : state.reviewFocusPath,
        browserOpenKeys:
          closing?.tool === 'browser'
            ? withBrowserOpenKey(state.browserOpenKeys, appSessionId, false)
            : state.browserOpenKeys,
      };
    }

    case 'ACTIVATE_UTILITY_TAB': {
      const appSessionId = state.activeAppSessionId;
      if (!appSessionId) return state;
      const current = state.utilityPanels[appSessionId];
      const panel = activateUtilityTab(current, action.tabId);
      if (panel === current) return state;
      return {
        ...state,
        rightPanelOpen: false,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
      };
    }

    case 'UPDATE_UTILITY_TAB': {
      const appSessionId = action.appSessionId ?? state.activeAppSessionId;
      if (!appSessionId) return state;
      const current = state.utilityPanels[appSessionId];
      const panel = updateUtilityTab(current, action.tabId, {
        terminalId: action.terminalId,
        cwd: action.cwd,
        filePath: action.filePath,
        label: action.label,
      });
      if (panel === current) return state;
      return {
        ...state,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
      };
    }

    case 'SET_UTILITY_PANEL_OPEN': {
      const appSessionId = state.activeAppSessionId;
      if (!appSessionId) return state;
      const current = utilityPanelForSession(state.utilityPanels, appSessionId);
      const panel = setUtilityPanelOpen(current, action.open);
      if (panel === current && (!action.open || !state.rightPanelOpen)) return state;
      return {
        ...state,
        rightPanelOpen: action.open ? false : state.rightPanelOpen,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
      };
    }

    case 'SET_REVIEW_OPEN':
      // Closing while already closed AND no pending focus is a true no-op; bail
      // before allocating a new state object so subscribers don't re-render. The
      // reviewFocusPath check is essential: a close dispatched when the pane is
      // already shut but a focus path is still pending would otherwise skip the
      // clear and leave the stale focus request to fire on the next open.
      if (
        !action.open &&
        state.reviewOpenAppSessionId === null &&
        state.reviewFocusPath === null &&
        !utilityPanelForSession(state.utilityPanels, state.activeAppSessionId).tabs.some(
          (tab) => tab.tool === 'review',
        )
      )
        return state;
      // Scope the open state to the active session so it never leaks into the
      // next chat; switching back to this session restores it.
      if (action.open && state.activeAppSessionId) {
        const appSessionId = state.activeAppSessionId;
        return {
          ...state,
          rightPanelOpen: false,
          reviewOpenAppSessionId: appSessionId,
          utilityPanels: {
            ...state.utilityPanels,
            [appSessionId]: openUtilityTool(
              state.utilityPanels[appSessionId],
              'review',
              () => `review:${appSessionId}`,
            ),
          },
        };
      }
      return {
        ...state,
        reviewOpenAppSessionId: null,
        reviewFocusPath: null,
        utilityPanels: state.activeAppSessionId
          ? {
              ...state.utilityPanels,
              [state.activeAppSessionId]: removeUtilityTool(
                state.utilityPanels[state.activeAppSessionId],
                'review',
              ),
            }
          : state.utilityPanels,
      };

    case 'SET_REVIEW_SCOPE':
      return { ...state, reviewScope: saveReviewScope(action.scope) };

    case 'OPEN_REVIEW_AT':
      // Open the Review pane for the active session at a given scope, optionally
      // asking it to jump to a specific file once the diff list has loaded.
      if (!state.activeAppSessionId) {
        return {
          ...state,
          reviewScope: saveReviewScope(action.scope),
          reviewFocusPath: action.path ?? null,
          reviewFocusRequestId: state.reviewFocusRequestId + 1,
        };
      }
      return {
        ...state,
        rightPanelOpen: false,
        reviewOpenAppSessionId: state.activeAppSessionId,
        reviewScope: saveReviewScope(action.scope),
        reviewFocusPath: action.path ?? null,
        reviewFocusRequestId: state.reviewFocusRequestId + 1,
        utilityPanels: {
          ...state.utilityPanels,
          [state.activeAppSessionId]: openUtilityTool(
            state.utilityPanels[state.activeAppSessionId],
            'review',
            () => `review:${state.activeAppSessionId}`,
          ),
        },
      };

    case 'CLEAR_REVIEW_FOCUS':
      return state.reviewFocusPath === null ? state : { ...state, reviewFocusPath: null };

    case 'SET_DIFF_VIEW':
      return { ...state, diffView: saveDiffView(action.mode) };

    case 'TOGGLE_COMMAND_PALETTE':
      return { ...state, commandPaletteOpen: !state.commandPaletteOpen };

    case 'CLOSE_COMMAND_PALETTE':
      return { ...state, commandPaletteOpen: false };

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };

    case 'TOGGLE_SPEC_MODE':
      return { ...state, specMode: !state.specMode };

    case 'SESSION_SET_INTERACTION_MODE': {
      // Optimistic interaction-mode flip so the spec toggle reflects instantly;
      // a later SESSION_UPDATED from the backend confirms (or corrects) it.
      const session = state.sessions[action.appSessionId];
      if (!session || session.interactionMode === action.interactionMode) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.appSessionId]: { ...session, interactionMode: action.interactionMode },
        },
      };
    }

    case 'TOGGLE_SETTINGS':
      return { ...state, settingsOpen: !state.settingsOpen };

    case 'TOGGLE_MISSION_CONTROL':
      return { ...state, missionControlMode: !state.missionControlMode };

    case 'START_CHAT': {
      // Stamp the session being left so model output produced while it was
      // open doesn't surface as an unread badge after starting a new chat.
      const sessionLastSeen = { ...state.sessionLastSeen };
      if (state.activeAppSessionId && state.sessions[state.activeAppSessionId]) {
        sessionLastSeen[state.activeAppSessionId] = Date.now();
      }
      const next = invalidateSelectedChildOpening(state);
      return {
        ...next,
        draftChat: {
          cwd: action.cwd,
          executionMode: action.executionMode,
          branch: action.branch,
        },
        draftAutonomy: null,
        activeAppSessionId: null,
        missionControlMode: false,
        selectedChild: null,
        // Leaving for a fresh draft orphans any pending review-focus request.
        reviewFocusPath: null,
        sessionLastSeen,
      };
    }

    case 'SEED_COMPOSER':
      return { ...state, composerSeed: { text: action.text, id: Date.now() } };

    // The composer consumes the seed once; it must not linger, or remounting
    // the composer (e.g. toggling Mission Control) would re-apply stale text.
    case 'CLEAR_COMPOSER_SEED':
      return { ...state, composerSeed: null };

    case 'SESSION_NOTE_ADD': {
      const sessionNotes = addSessionNote(state.sessionNotes, action.appSessionId, action.text);
      // Blank notes are rejected by the helper; nothing changed.
      if (!sessionNotes) return state;
      return { ...state, sessionNotes };
    }

    case 'SESSION_NOTE_MARK_USED': {
      const sessionNotes = markSessionNoteUsed(
        state.sessionNotes,
        action.appSessionId,
        action.noteId,
      );
      // Already marked or unknown note; nothing changed.
      if (!sessionNotes) return state;
      return { ...state, sessionNotes };
    }

    case 'SESSION_NOTE_REMOVE':
      return {
        ...state,
        sessionNotes: removeSessionNote(state.sessionNotes, action.appSessionId, action.noteId),
      };

    case 'ADD_WORKSPACE':
      return {
        ...state,
        workspaceCwds: saveWorkspaceCwds(addWorkspaceCwd(state.workspaceCwds, action.cwd)),
      };

    case 'SET_WORKSPACE_CWDS':
      return { ...state, workspaceCwds: saveWorkspaceCwds(action.cwds) };

    case 'TOGGLE_BROWSER': {
      const key = activeBrowserKey(state);
      if (!key) return state;
      const current = utilityPanelForSession(state.utilityPanels, key);
      const existing = current.tabs.find((tab) => tab.tool === 'browser');
      const opening = !existing || !current.open || current.activeTabId !== existing.id;
      return {
        ...state,
        rightPanelOpen: opening ? false : state.rightPanelOpen,
        utilityPanels: {
          ...state.utilityPanels,
          [key]: opening
            ? openUtilityTool(current, 'browser', () => `browser:${key}`)
            : setUtilityPanelOpen(current, false),
        },
        browserOpenKeys: withBrowserOpenKey(state.browserOpenKeys, key, opening),
      };
    }

    case 'SET_BROWSER_OPEN': {
      const key = activeBrowserKey(state);
      if (!key) return state;
      return {
        ...state,
        rightPanelOpen: action.open ? false : state.rightPanelOpen,
        utilityPanels: {
          ...state.utilityPanels,
          [key]: action.open
            ? openUtilityTool(state.utilityPanels[key], 'browser', () => `browser:${key}`)
            : removeUtilityTool(state.utilityPanels[key], 'browser'),
        },
        browserOpenKeys: withBrowserOpenKey(state.browserOpenKeys, key, action.open),
      };
    }

    case 'BROWSER_UPDATED': {
      if (!action.browser.appSessionId) return state;
      const appSessionId = action.browser.appSessionId;
      // Surface a freshly opened browser, but never re-open a pane the user hid.
      // Missing keys differ from explicitly hidden panes.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
      const hidden = state.browserOpenKeys[appSessionId] === false;
      return {
        ...state,
        browsers: { ...state.browsers, [appSessionId]: action.browser },
        browserErrors: Object.fromEntries(
          Object.entries(state.browserErrors).filter(([id]) => id !== appSessionId),
        ),
        browserOpenKeys: hidden
          ? state.browserOpenKeys
          : withBrowserOpenKey(state.browserOpenKeys, appSessionId, true),
        utilityPanels: hidden
          ? state.utilityPanels
          : {
              ...state.utilityPanels,
              [appSessionId]: openUtilityTool(
                state.utilityPanels[appSessionId],
                'browser',
                () => `browser:${appSessionId}`,
              ),
            },
      };
    }

    case 'BROWSER_NAVIGATED': {
      const browser = state.browsers[action.appSessionId];
      // Keep the existence guard because the update below dereferences browser.
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
      if (!browser || browser.browserSessionId !== action.browserSessionId) return state;
      return {
        ...state,
        browsers: {
          ...state.browsers,
          [action.appSessionId]: {
            ...browser,
            url: action.url,
            canGoBack: action.canGoBack ?? browser.canGoBack,
            canGoForward: action.canGoForward ?? browser.canGoForward,
          },
        },
      };
    }

    case 'BROWSER_CLOSED':
      // Full close: drop the session's browser, design mode, and open flag so a
      // later reopen starts fresh (and it is excluded from persistence).
      return {
        ...state,
        browsers: Object.fromEntries(
          Object.entries(state.browsers).filter(([id]) => id !== action.appSessionId),
        ),
        browserErrors: Object.fromEntries(
          Object.entries(state.browserErrors).filter(([id]) => id !== action.appSessionId),
        ),
        designModes: clearDesignMode(state.designModes, action.appSessionId),
        browserOpenKeys: clearBrowserOpenKey(state.browserOpenKeys, action.appSessionId),
        utilityPanels: {
          ...state.utilityPanels,
          [action.appSessionId]: removeUtilityTool(
            state.utilityPanels[action.appSessionId],
            'browser',
          ),
        },
      };

    case 'BROWSER_ERROR':
      if (!action.appSessionId) return { ...state, browserGlobalError: action.message };
      return {
        ...state,
        browserErrors: { ...state.browserErrors, [action.appSessionId]: action.message },
        // Respect an explicit hide; otherwise surface the errored browser.
        browserOpenKeys:
          // Missing keys differ from explicitly hidden panes.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
          state.browserOpenKeys[action.appSessionId] === false
            ? state.browserOpenKeys
            : withBrowserOpenKey(state.browserOpenKeys, action.appSessionId, true),
      };

    case 'TOGGLE_DESIGN_MODE':
      return {
        ...state,
        designModes: toggleDesignMode(state.designModes, action.appSessionId),
      };

    case 'SET_DESIGN_MODE':
      return {
        ...state,
        designModes: setDesignMode(state.designModes, action.appSessionId, action.open),
      };

    case 'SET_THEME': {
      const next = { ...state.theme, ...action.theme };
      try {
        getLocalStorage()?.setItem('droid-theme', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return { ...state, theme: next };
    }

    // Pure state transitions only: persistence happens in the dispatching
    // handler (see persistCustomThemes), never in the root reducer.
    case 'SAVE_CUSTOM_THEME':
      return { ...state, customThemes: upsertCustomTheme(state.customThemes, action.preset) };

    case 'DELETE_CUSTOM_THEME':
      return { ...state, customThemes: removeCustomTheme(state.customThemes, action.id) };

    case 'SELECT_FEATURE':
      return { ...state, selectedFeatureId: action.id };

    case 'SELECT_CHILD': {
      const previous = state.selectedChild;
      let next =
        previous &&
        (action.selection?.parentAppSessionId !== previous.parentAppSessionId ||
          action.selection.childSessionId !== previous.childSessionId)
          ? invalidateSelectedChildOpening(releaseInactiveSelectedChild(state))
          : state;
      if (!action.selection) return { ...next, selectedChild: null };
      const { parentAppSessionId, childSessionId } = action.selection;
      if (
        next.activeAppSessionId !== parentAppSessionId ||
        !next.childSessions[parentAppSessionId]?.[childSessionId]
      )
        return { ...next, selectedChild: null };
      next = { ...next, selectedChild: action.selection };
      if (action.requestId) {
        const opening = withChildAccess(next, parentAppSessionId, childSessionId, {
          state: 'opening',
          requestId: action.requestId,
        });
        /* eslint-disable @typescript-eslint/no-unnecessary-condition -- sparse keyed renderer maps */
        const history = opening.childHistory[parentAppSessionId]?.[childSessionId];
        if (history?.isLoaded) return opening;
        const loadedCount = (opening.transcripts[parentAppSessionId] ?? []).filter(
          (event) => event.sourceSessionId === childSessionId,
        ).length;
        return withChildHistory(opening, parentAppSessionId, childSessionId, {
          status: 'loading',
          loadedCount,
          hasMore: false,
          isLoaded: false,
          isLoadingOlder: false,
          isViewportPinned: history?.isViewportPinned ?? true,
        });
        /* eslint-enable @typescript-eslint/no-unnecessary-condition */
      }
      const access = next.childAccess[parentAppSessionId]?.[childSessionId];
      return access?.state === 'failed' || access?.state === 'closed'
        ? withoutChildAccess(next, parentAppSessionId, childSessionId)
        : next;
    }

    case 'MODELS_LIST':
      return {
        ...state,
        models: action.models,
        agentConfig: saveAgentConfig(sanitizeAgentConfig(state.agentConfig, action.models)),
      };

    case 'SKILLS_LIST':
      return {
        ...state,
        skills: action.skills,
        skillsProviderSessionId: action.providerSessionId,
      };

    case 'FACTORY_DEFAULTS': {
      const next = sanitizeAgentConfig(
        {
          primary: {
            modelId: state.agentConfig.primary.modelId ?? action.defaults.modelId,
            reasoning: state.agentConfig.primary.modelId
              ? state.agentConfig.primary.reasoning
              : (action.defaults.reasoningEffort ?? state.agentConfig.primary.reasoning),
          },
          worker: {
            modelId: state.agentConfig.worker.modelId ?? action.defaults.workerModelId,
            reasoning: state.agentConfig.worker.modelId
              ? state.agentConfig.worker.reasoning
              : (action.defaults.workerReasoningEffort ?? state.agentConfig.worker.reasoning),
          },
          validator: {
            modelId: state.agentConfig.validator.modelId ?? action.defaults.validatorModelId,
            reasoning: state.agentConfig.validator.modelId
              ? state.agentConfig.validator.reasoning
              : (action.defaults.validatorReasoningEffort ?? state.agentConfig.validator.reasoning),
          },
        },
        state.models,
      );

      // Seed Factory defaults only before local compaction settings exist. An
      // explicit clear stores an empty local value and must not resurrect
      // Factory's old per-model/default threshold on the next defaults event.
      const compactionDefaults = applyFactoryCompactionDefaults(state, action.defaults);

      return {
        ...state,
        agentConfig: saveAgentConfig(next),
        ...compactionDefaults,
        compactionSettingsRev: state.compactionSettingsRev + 1,
      };
    }

    case 'SET_AGENT_MODEL':
      return {
        ...state,
        agentConfig: saveAgentConfig({
          ...state.agentConfig,
          [action.agent]: { ...state.agentConfig[action.agent], modelId: action.modelId },
        }),
      };

    case 'SET_AGENT_REASONING':
      return {
        ...state,
        agentConfig: saveAgentConfig({
          ...state.agentConfig,
          [action.agent]: { ...state.agentConfig[action.agent], reasoning: action.reasoning },
        }),
      };

    case 'SESSION_SET_MODEL': {
      const m = state.sessions[action.appSessionId];
      if (!m) return state;
      const prevOverride = state.sessionSettingOverrides[action.appSessionId] ?? {};
      return {
        ...state,
        sessions: { ...state.sessions, [action.appSessionId]: { ...m, modelId: action.modelId } },
        sessionSettingOverrides: {
          ...state.sessionSettingOverrides,
          [action.appSessionId]: { ...prevOverride, modelId: action.modelId },
        },
      };
    }

    case 'SESSION_SET_REASONING': {
      const m = state.sessions[action.appSessionId];
      if (!m) return state;
      const prevOverride = state.sessionSettingOverrides[action.appSessionId] ?? {};
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.appSessionId]: { ...m, reasoningEffort: action.reasoning },
        },
        sessionSettingOverrides: {
          ...state.sessionSettingOverrides,
          [action.appSessionId]: { ...prevOverride, reasoningEffort: action.reasoning },
        },
      };
    }

    case 'SET_COMPACTION_MODEL_GLOBAL': {
      const value = saveCompactionModel(action.compactionModel);
      return { ...state, compactionModel: value };
    }

    case 'SET_COMPACTION_TOKEN_LIMIT_GLOBAL': {
      const limit = normalizeTokenLimit(action.limit);
      saveCompactionTokenLimit(limit);
      return {
        ...state,
        compactionTokenLimit: limit,
        compactionSettingsRev: state.compactionSettingsRev + 1,
      };
    }

    case 'SET_COMPACTION_TOKEN_LIMIT_FOR_MODEL': {
      const limit = normalizeTokenLimit(action.limit);
      const next = { ...state.compactionTokenLimitPerModel };
      if (limit === undefined) delete next[action.modelId];
      else next[action.modelId] = limit;
      saveCompactionTokenLimitPerModel(next);
      return {
        ...state,
        compactionTokenLimitPerModel: next,
        compactionSettingsRev: state.compactionSettingsRev + 1,
      };
    }

    case 'SET_LIVE_ENTER_BEHAVIOR': {
      const behavior = saveLiveEnterBehavior(action.behavior);
      return { ...state, liveEnterBehavior: behavior };
    }

    case 'SET_IMAGE_PASTE_QUALITY': {
      const quality = saveImagePasteQuality(action.quality);
      return { ...state, imagePasteQuality: quality };
    }

    case 'SET_DEFAULT_AUTONOMY': {
      saveDefaultAutonomy(action.autonomy);
      return { ...state, defaultAutonomy: action.autonomy };
    }

    case 'SET_DRAFT_AUTONOMY':
      return { ...state, draftAutonomy: action.autonomy };

    case 'AUTONOMY_UPDATE_REQUESTED':
      return {
        ...state,
        pendingAutonomy: { ...state.pendingAutonomy, [action.appSessionId]: action.autonomy },
      };

    case 'AUTONOMY_UPDATE_SETTLED': {
      if (!(action.appSessionId in state.pendingAutonomy)) return state;
      return {
        ...state,
        pendingAutonomy: Object.fromEntries(
          Object.entries(state.pendingAutonomy).filter(([id]) => id !== action.appSessionId),
        ),
      };
    }

    default:
      return state;
  }
}

function loadPersistedBrowsers(value: unknown): Record<string, BrowserState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, browser]) => [key, sanitizePersistedBrowser(key, browser)] as const)
    .filter((entry): entry is readonly [string, BrowserState] => Boolean(entry[1]));
  return Object.fromEntries(entries);
}

function loadPersistedBrowserOpenKeys(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // Preserve both true (open) and false (explicitly hidden) so the "hidden"
  // decision survives a restart; a dropped `false` would let later updates
  // re-open a pane the user deliberately hid.
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, boolean] =>
      typeof entry[0] === 'string' && entry[0].length > 0 && typeof entry[1] === 'boolean',
  );
  return Object.fromEntries(entries);
}

function sanitizePersistedBrowser(key: string, value: unknown): BrowserState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const browser = value as Partial<BrowserState>;
  if (typeof browser.browserSessionId !== 'string' || !browser.browserSessionId) return undefined;
  if (typeof browser.url !== 'string' || !browser.url) return undefined;
  const viewport = sanitizeBrowserViewport(browser.viewport);
  if (!viewport) return undefined;
  return {
    browserSessionId: browser.browserSessionId,
    appSessionId:
      typeof browser.appSessionId === 'string' && browser.appSessionId ? browser.appSessionId : key,
    url: browser.url,
    title: typeof browser.title === 'string' ? browser.title : undefined,
    viewport,
    viewportMode: sanitizeBrowserViewportMode(browser.viewportMode),
    scroll: sanitizeBrowserScroll(browser.scroll),
    refs: [],
    ...(browser.canGoBack === true ? { canGoBack: true } : {}),
    ...(browser.canGoForward === true ? { canGoForward: true } : {}),
  };
}

function sanitizeBrowserViewport(value: unknown): BrowserState['viewport'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const viewport = value as Partial<BrowserState['viewport']>;
  const width = finitePositiveNumber(viewport.width);
  const height = finitePositiveNumber(viewport.height);
  const deviceScaleFactor = finitePositiveNumber(viewport.deviceScaleFactor);
  if (!width || !height || !deviceScaleFactor) return undefined;
  return { width, height, deviceScaleFactor };
}

function sanitizeBrowserViewportMode(value: unknown): BrowserViewportMode {
  return BROWSER_VIEWPORT_MODES.has(value as BrowserViewportMode)
    ? (value as BrowserViewportMode)
    : 'fit';
}

function sanitizeBrowserScroll(value: unknown): BrowserState['scroll'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { x: 0, y: 0 };
  const scroll = value as Partial<BrowserState['scroll']>;
  return { x: finiteNumber(scroll.x) ?? 0, y: finiteNumber(scroll.y) ?? 0 };
}

function persistBrowsers(browsers: Record<string, BrowserState>): Record<string, BrowserState> {
  return Object.fromEntries(
    Object.entries(browsers).map(([key, browser]) => [
      key,
      {
        ...browser,
        refs: [],
        agentCursor: undefined,
        screenshotPath: undefined,
        screenshotUrl: undefined,
      },
    ]),
  );
}

function finitePositiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number && number > 0 ? number : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* ── Bridge event adapter ── */
export function toastMessageForEvent(ev: ServerEvent): string | undefined {
  if (
    ev.type === 'error' &&
    (ev.code === 'bridge.unsupported_command' || ev.code === 'bridge.resync_required')
  ) {
    return ev.message;
  }
  if (
    ev.type === 'error' &&
    (ev.code === 'session.autonomy_update_failed' || ev.code === 'session.create_failed')
  ) {
    return ev.message;
  }
  return ev.type === 'child.error' && ev.operation !== 'open' ? ev.message : undefined;
}

export function adaptEvent(ev: ServerEvent): Action | null {
  switch (ev.type) {
    case 'connection':
      return {
        type: 'SET_CONNECTION',
        status: ev.status === 'connected' ? 'connected' : 'error',
        message: ev.message,
      };
    case 'session.created':
      return { type: 'SESSION_CREATED', clientRef: ev.clientRef, session: ev.session };
    case 'session.updated':
      return { type: 'SESSION_UPDATED', session: ev.session };
    case 'session.closed':
      return { type: 'SESSION_CLOSED', appSessionId: ev.appSessionId };
    case 'mission.features':
      return { type: 'SESSION_FEATURES', appSessionId: ev.appSessionId, features: ev.features };
    case 'mission.progress':
      return { type: 'SESSION_PROGRESS', appSessionId: ev.appSessionId, entries: ev.entries };
    case 'session.child':
      return {
        type: 'SESSION_CHILD',
        child: ev.child,
        runtimeAvailable: ev.runtimeAvailable,
        runtimeGeneration: ev.runtimeGeneration,
      };
    case 'child.updated':
      return ev.access === 'ready'
        ? {
            type: 'CHILD_UPDATED',
            parentAppSessionId: ev.parentAppSessionId,
            childSessionId: ev.childSessionId,
            requestId: ev.requestId,
            access: 'ready',
            runtimeGeneration: ev.runtimeGeneration,
          }
        : {
            type: 'CHILD_UPDATED',
            parentAppSessionId: ev.parentAppSessionId,
            childSessionId: ev.childSessionId,
            requestId: ev.requestId,
            access: 'history',
          };
    case 'child.error':
      return {
        type: 'CHILD_ERROR',
        parentAppSessionId: ev.parentAppSessionId,
        childSessionId: ev.childSessionId,
        requestId: ev.requestId,
        operation: ev.operation,
        message: ev.message,
      };
    case 'event.appended':
      return { type: 'SESSION_TRANSCRIPT', event: ev.event };
    case 'approval.requested':
      return { type: 'SESSION_PERMISSION', request: ev.request };
    case 'question.requested':
      return { type: 'SESSION_QUESTION', question: ev.question };
    case 'error':
      if (ev.code === 'bridge.resync_required' && !ev.recoverable) {
        return { type: 'SET_CONNECTION', status: 'error', message: ev.message };
      }
      // A failed autonomy change is recoverable: the session keeps its last
      // confirmed level, the pending state settles, and the toast carries the
      // message (see toastMessageForEvent).
      if (ev.code === 'session.autonomy_update_failed') {
        return ev.appSessionId
          ? { type: 'AUTONOMY_UPDATE_SETTLED', appSessionId: ev.appSessionId }
          : null;
      }
      if (ev.code === 'session.create_failed' && ev.clientRef) {
        return {
          type: 'SESSION_CREATE_FAILED',
          clientRef: ev.clientRef,
          message: ev.message,
        };
      }
      if (ev.recoverable) return null;
      if (ev.appSessionId) {
        return {
          type: 'SESSION_ERROR',
          appSessionId: ev.appSessionId,
          providerSessionId: ev.providerSessionId,
          message: ev.message,
        };
      }
      return { type: 'SESSION_ERROR', message: ev.message };
    case 'sessions.list':
      return { type: 'SESSION_LIST', sessions: ev.sessions };
    case 'session.history':
      return {
        type: 'SESSION_HISTORY',
        appSessionId: ev.appSessionId,
        childSessionId: ev.childSessionId,
        progress: ev.progress,
        transcripts: ev.transcripts,
        childSessions: ev.childSessions,
        mode: ev.mode,
        olderCursor: ev.olderCursor,
        loadedCount: ev.loadedCount,
        hasMore: ev.hasMore,
      };
    case 'session.history.error':
      return {
        type: 'SESSION_HISTORY_FAILED',
        appSessionId: ev.appSessionId,
        childSessionId: ev.childSessionId,
        message: ev.message,
      };
    case 'context.updated':
      return {
        type: 'CONTEXT_UPDATED',
        appSessionId: ev.appSessionId,
        sourceSessionId: ev.sourceSessionId,
        ...(ev.parentAppSessionId === undefined
          ? {}
          : { parentAppSessionId: ev.parentAppSessionId }),
        ...(ev.childSessionId === undefined ? {} : { childSessionId: ev.childSessionId }),
        stats: ev.stats,
      };
    case 'catalog.updated':
      if (ev.catalog === 'models') {
        return { type: 'MODELS_LIST', models: ev.items as ModelInfo[] };
      }
      if (ev.catalog === 'skills') {
        const skills = (ev.items as SkillInfo[]).filter(
          (s) => s && typeof s.name === 'string' && s.name.length > 0,
        );
        return {
          type: 'SKILLS_LIST',
          skills,
          providerSessionId: ev.providerSessionId ?? null,
        };
      }
      return null;
    case 'settings.defaults':
      return { type: 'FACTORY_DEFAULTS', defaults: ev.defaults };
    case 'browser.updated':
      return { type: 'BROWSER_UPDATED', browser: ev.state };
    case 'browser.closed':
      return { type: 'BROWSER_CLOSED', appSessionId: ev.appSessionId };
    case 'browser.error':
      return { type: 'BROWSER_ERROR', appSessionId: ev.appSessionId, message: ev.message };
    default:
      return null;
  }
}

interface StoreContextValue {
  getState: () => AppState;
  subscribe: (listener: () => void) => () => void;
  dispatch: React.Dispatch<Action>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, reduceDispatch] = useReducer(reducer, initialState, syncBrowserOpen);
  const stateRef = useRef(state);
  const listenersRef = useRef(new Set<() => void>());
  const bridgeActionBatcherRef = useRef<OrderedActionBatcher<Action> | null>(null);
  const dispatch = useCallback<React.Dispatch<Action>>((action) => {
    // A bridge event received before this local action must reduce first even
    // when it is waiting in the current frame's follower batch.
    const batcher = bridgeActionBatcherRef.current;
    if (batcher) batcher.dispatchLocal(action);
    else reduceDispatch(action);
  }, []);
  const [store] = useState<StoreContextValue>(() => ({
    getState: () => stateRef.current,
    subscribe: (listener) => {
      listenersRef.current.add(listener);
      return () => {
        listenersRef.current.delete(listener);
      };
    },
    dispatch,
  }));

  useLayoutEffect(() => {
    stateRef.current = state;
    // Closes the perf receive→commit leg for events reduced by this commit.
    noteStoreCommitted();
    for (const listener of listenersRef.current) listener();
  }, [state]);

  useEffect(() => {
    savePersistedUiState(state);
    saveSessionLastSeen(state.sessionLastSeen);
    saveSessionNotes(state.sessionNotes);
    saveChatMetadata(state.chatMetadata);
  }, [
    state.sessionLastSeen,
    state.sessionNotes,
    state.chatMetadata,
    state.activeAppSessionId,
    state.browserOpenKeys,
    state.browsers,
    state.missionControlMode,
    state.rightPanelOpen,
    state.utilityPanels,
    state.selectedChild,
    state.selectedFeatureId,
    state.sidebarCollapsed,
    state.specMode,
  ]);

  // Keep the sidecar's compaction-limit snapshot in sync so live sessions,
  // resumes, and model changes all follow these limits. The bridge queues
  // commands until the socket opens, so the mount-time push is safe. Keyed on
  // the settings revision rather than the values: a clear can leave the values
  // structurally identical (undefined -> undefined) while the user-configured
  // markers changed, and that must still reach the sidecar.
  useEffect(() => {
    updateCompactionSettings(compactionSettingsSnapshot(state));
  }, [state.compactionSettingsRev]);

  // Persist the reload snapshot only when the session list or the active
  // transcript actually changed (references are immutable), debounced so
  // streaming bursts coalesce into one write. The scheduler owns its timer,
  // so an unrelated state change can never cancel a pending write, and the
  // effect depends on the derived active transcript so background sessions'
  // transcript updates do not retrigger it.
  const [snapshotScheduler] = useState(() => createSnapshotScheduler(400));
  const activeTranscriptEvents = state.activeAppSessionId
    ? state.transcripts[state.activeAppSessionId]
    : undefined;
  useEffect(() => {
    const activeId = state.activeAppSessionId;
    snapshotScheduler.push({
      sessions: state.sessions,
      sessionOrder: state.sessionOrder,
      activeTranscript:
        activeId !== null && activeTranscriptEvents !== undefined
          ? { appSessionId: activeId, events: activeTranscriptEvents }
          : undefined,
    });
  }, [
    snapshotScheduler,
    state.sessions,
    state.sessionOrder,
    state.activeAppSessionId,
    activeTranscriptEvents,
  ]);
  useEffect(
    () => () => {
      snapshotScheduler.cancel();
    },
    [snapshotScheduler],
  );

  useEffect(() => {
    // Concurrent streams can deliver many bridge events per frame (token
    // deltas, usage and context telemetry, child updates), and every dispatch
    // still notifies each selective subscriber. Batch per frame with a leading
    // edge: the first event after an idle gap dispatches immediately
    // (interactive round-trips stay instant), followers arriving within the
    // same 16ms window flush together as one ordered state transition.
    const batcher = createOrderedActionBatcher<Action, number>({
      dispatchOne: reduceDispatch,
      dispatchBatch: (actions) => {
        reduceDispatch({ type: 'BATCH', actions });
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timer) => {
        window.clearTimeout(timer);
      },
      delayMs: 16,
    });
    bridgeActionBatcherRef.current = batcher;
    const unsub = bridge.subscribeBatch((events) => {
      const actions: Action[] = [];
      for (const ev of events) {
        // Verbose per-event logging runs on every streaming token and eagerly
        // deep-clones + redacts the whole event, so keep it to dev builds only;
        // production strips this branch entirely.
        if (import.meta.env.DEV) console.log('[bridge]', ev.type, sanitizeForLog(ev));
        const toastMessage = toastMessageForEvent(ev);
        if (toastMessage !== undefined) toast.error(toastMessage);
        const action = adaptEvent(ev);
        if (!action) {
          // No reducer work means no commit: drop the perf leg instead of
          // closing it against the next unrelated commit.
          discardPendingBridgeEvent(ev);
          continue;
        }
        actions.push(action);
      }
      batcher.pushBridgeBatch(actions);
    });
    return () => {
      unsub();
      // StrictMode remounts this effect in dev; deliver anything in flight so
      // no event is lost across the resubscribe.
      batcher.dispose();
      if (bridgeActionBatcherRef.current === batcher) bridgeActionBatcherRef.current = null;
    };
  }, []);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function StaticStoreProvider({
  state,
  dispatch,
  children,
}: {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  children: ReactNode;
}) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const [store] = useState<StoreContextValue>(() => ({
    getState: () => stateRef.current,
    subscribe: () => () => undefined,
    dispatch,
  }));
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

function useStoreContext(): StoreContextValue {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used within StoreProvider');
  return context;
}

export function useStoreApi(): Pick<StoreContextValue, 'getState'> {
  return useStoreContext();
}

export function useStoreDispatch(): React.Dispatch<Action> {
  return useStoreContext().dispatch;
}

export function useStoreSelector<Selected>(
  selector: (state: AppState) => Selected,
  isEqual: (left: Selected, right: Selected) => boolean = Object.is,
): Selected {
  const store = useStoreContext();
  const committedSelectionRef = useRef<{ hasValue: false } | { hasValue: true; value: Selected }>({
    hasValue: false,
  });
  const getSelection = useMemo(() => {
    let hasMemo = false;
    let memoizedState: AppState;
    let memoizedSelection: Selected;
    return () => {
      const nextState = store.getState();
      if (!hasMemo) {
        hasMemo = true;
        memoizedState = nextState;
        const nextSelection = selector(nextState);
        const committed = committedSelectionRef.current;
        if (committed.hasValue && isEqual(committed.value, nextSelection)) {
          memoizedSelection = committed.value;
          return committed.value;
        }
        memoizedSelection = nextSelection;
        return nextSelection;
      }
      if (Object.is(memoizedState, nextState)) return memoizedSelection;
      const nextSelection = selector(nextState);
      memoizedState = nextState;
      if (isEqual(memoizedSelection, nextSelection)) return memoizedSelection;
      memoizedSelection = nextSelection;
      return nextSelection;
    };
  }, [isEqual, selector, store]);
  const selection = useSyncExternalStore(store.subscribe, getSelection, getSelection);
  useEffect(() => {
    committedSelectionRef.current = { hasValue: true, value: selection };
  }, [selection]);
  return selection;
}

export function shallowEqual<T extends Record<string, unknown>>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}
