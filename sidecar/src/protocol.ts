// Bridge protocol shared between the Node sidecar and the React frontend.
// The frontend keeps a mirror copy at src/types/bridge.ts — keep them in sync.

import type { McpClientCommand, McpServerEvent } from './mcpProtocol.js';
import type {
  DroidMissionConfiguration,
  ProviderInstanceId,
  SessionConfiguration,
} from './providers/providerIdentity.js';
export type {
  McpServerInfo,
  McpServerInput,
  McpServerSource,
  McpServerStatus,
  McpServerType,
  McpStatusSummary,
  McpToolInfo,
} from './mcpProtocol.js';
export type {
  DroidAgentConfiguration,
  DroidMissionConfiguration,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSelection,
  SessionConfiguration,
} from './providers/providerIdentity.js';

export type SessionPhase =
  | 'intake'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'awaiting_run_start'
  | 'initializing'
  | 'running'
  | 'orchestrator_turn'
  | 'paused'
  | 'completed'
  | 'failed';

export type FeatureStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type SessionRole = 'primary' | 'worker' | 'validator';
export type SessionPurpose = 'chat' | 'design' | 'mission-control';
export type SessionInteractionMode = 'auto' | 'spec' | 'agi';
export type ResponseFormat = 'app-create' | 'app-followup';
export type RunStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'blocked';
export type Autonomy = 'off' | 'low' | 'medium' | 'high';
export type ReasoningEffort =
  | 'off'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'dynamic';

export interface BridgeFeature {
  id: string;
  description: string;
  status: FeatureStatus;
  skillName: string;
  preconditions: string[];
  expectedBehavior: string[];
  verificationSteps: string[];
  fulfills?: string[];
  milestone?: string;
}

export interface ProgressEntry {
  type: string;
  timestamp: string;
  title?: string;
  message?: string;
  featureId?: string;
  workerChildSessionId?: string;
}

export type ChildRole = 'worker' | 'validator';
export type ChildStatus = 'pending' | 'running' | 'paused' | 'completed';
export type StreamFidelity = 'token' | 'tool' | 'state';

export interface ChildSpawnLink {
  kind: 'tool-use' | 'spawn';
  id: string;
}

// Live activity of an autonomous child, as observed by polling its background
// task from the parent: the task's status ("Running", "Completed") and the last
// line it had produced at that moment.
export interface ChildActivity {
  phase?: string;
  preview?: string;
}

export interface ChildSessionSummary {
  parentAppSessionId: string;
  childSessionId: string;
  role: ChildRole;
  status: ChildStatus;
  label?: string;
  prompt?: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  // Confirmed effective autonomy, runtime-scoped: present only while the child
  // is live in this runtime (opened at least once). Absent for historical or
  // never-opened children; never inherited from the parent.
  autonomy?: Autonomy;
  spawnLink?: ChildSpawnLink;
  transcriptAvailable: boolean;
  startedAt?: number;
  // Provider-declared: how live output actually arrives. Orthogonal to phase.
  streamFidelity: StreamFidelity;
  // Live-only (never persisted) and absent unless the parent actually polled the
  // child; autonomous children stream nothing to the parent themselves.
  activity?: ChildActivity;
  // Live-only: waiting for a runtime slot. Never persisted; never means running.
  queued?: boolean;
}

export interface ProviderSessionRef {
  /** Display and copy only. Never a routing key; commands still target appSessionId. */
  id: string;
  /** Provider-built CLI recipe, e.g. `droid -r 'abc'`. Absent when the provider has none. */
  resumeCommand?: string;
}

export interface SessionSummary {
  appSessionId: string;
  providerSessionId?: string;
  compactedFromProviderSessionIds?: string[];
  missionId?: string;
  sessionPurpose: SessionPurpose;
  role: 'primary' | 'user';
  title: string;
  goal: string;
  cwd: string;
  workspaceKind?: 'folder' | 'none';
  configuration: SessionConfiguration;
  droidMissionConfiguration?: DroidMissionConfiguration;
  compactionModel?: string;
  phase: SessionPhase;
  streaming?: boolean; // true while a turn is actively generating
  // Set when a runtime restart could not continue this session's in-flight turn.
  interruptReason?: string;
  queuedSends?: number;
  proposal?: string; // markdown plan from propose_mission
  features: BridgeFeature[];
  tokensIn: number;
  tokensOut: number;
  contextTokens: number;
  contextRemainingTokens?: number;
  contextAccuracy?: 'exact' | 'estimated';
  contextUpdatedAt?: string;
  maxContextTokens?: number;
  // The auto-compaction trigger the sidecar last armed on the daemon for this
  // session (already clamped below the model window), cleared when arming
  // failed. Recorded as diagnostic/persisted truth; compaction itself is
  // announced by the daemon and rendered in the transcript.
  compactionTokenLimit?: number;
  // In-place daemon auto-compactions completed on this session; the renderer
  // uses it as a monotonic generation when invalidating stale context telemetry.
  autoCompactions?: number;
  createdAt: number;
  updatedAt: number;
  sessionWebUrl?: string;
  sessionRef?: ProviderSessionRef;
}

export interface TranscriptEvent {
  id: string;
  appSessionId: string;
  sourceSessionId: string;
  role: SessionRole;
  ts: number;
  // Monotonic canonical order for primary-session scrollback, stamped during
  // replay from the compaction-chain position. Survives equal `ts` collisions
  // so restored history never reorders. Live events omit it (they are newest).
  seq?: number;
  endTs?: number;
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'compaction';
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolUseId?: string;
  isError?: boolean;
  // For a 'compaction' divider: how many messages the compaction summarized away.
  removedCount?: number;
  author?: 'user';
  // Frontend display metadata for user-authored prompt chips.
  skills?: string[];
  files?: string[];
  browserRefs?: BrowserTranscriptReference[];
  steered?: boolean;
  compactType?: 'auto' | 'manual';
}

export type BrowserTranscriptReferenceKind = 'element' | 'region' | 'text';

export interface BrowserTranscriptReference {
  id: string;
  label: string;
  kind: BrowserTranscriptReferenceKind;
  url?: string;
  selector?: string;
  imageDataUrl?: string;
}

export type PermissionKind =
  | 'edit'
  | 'exec'
  | 'create'
  | 'apply_patch'
  | 'mcp'
  | 'spec'
  | 'mission_plan'
  | 'other';
export type ConfigurableSessionRole = 'primary' | 'worker' | 'validator';

export interface PermissionRequest {
  appSessionId: string;
  requestId: string;
  kind: PermissionKind;
  title: string;
  detail: string; // human readable (command, file path, diff snippet)
  plan?: string; // full plan/spec body (exit_spec_mode)
  options?: string[]; // custom option names offered by the tool
  raw: unknown;
}

export interface SessionQuestion {
  appSessionId: string;
  requestId: string;
  questions: { index: number; question: string; options: string[] }[];
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider?: string;
  isCustom: boolean;
  isDefault?: boolean;
  maxContextTokens?: number;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface FactoryDefaultSettings {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  compactionModel?: string;
  compactionTokenLimit?: number;
  compactionTokenLimitPerModel?: Record<string, number>;
  autonomy?: Autonomy;
  interactionMode?: SessionInteractionMode;
  specModelId?: string;
  specReasoningEffort?: ReasoningEffort;
  missionOrchestratorModelId?: string;
  missionOrchestratorReasoningEffort?: ReasoningEffort;
  workerModelId?: string;
  workerReasoningEffort?: ReasoningEffort;
  validatorModelId?: string;
  validatorReasoningEffort?: ReasoningEffort;
}

export type InstallChannel = 'script' | 'brew' | 'npm';

export interface PackageManagers {
  brew: boolean;
  npm: boolean;
  curl: boolean;
  pnpm: boolean;
}

export interface CliInfo {
  present: boolean;
  path: string;
  version?: string;
}

export interface EnvironmentReport {
  platform: NodeJS.Platform;
  arch: string;
  osVersion: string;
  node: { present: boolean; version?: string };
  cli: CliInfo;
  packageManagers: PackageManagers;
  auth: { apiKeyConfigured: boolean; loginPresent: boolean };
  availableChannels: InstallChannel[];
}

export interface ContextStatsSnapshot {
  used: number;
  remaining: number;
  limit: number;
  accuracy: 'exact' | 'estimated';
  updatedAt: string;
  breakdown?: ContextBreakdownSnapshot;
  // In-place compactions completed on this agent session; set for worker
  // snapshots (top-level sessions carry their generation on the summary instead).
  compactions?: number;
}

export interface ContextBreakdownCategory {
  name: string;
  tokens: number;
  colorKey?: string;
}

export interface ContextBreakdownSnapshot {
  modelId?: string;
  modelDisplayName?: string;
  contextBudget: number;
  usedTokens: number;
  freeTokens: number;
  categories: ContextBreakdownCategory[];
}

export interface SessionHistoryEntry {
  providerSessionId: string;
  title: string;
  cwd?: string;
  modifiedTime: number;
  createdTime: number;
  messageCount: number;
}

// One transcript line that matched a sessions.search query, shaped for the
// sidebar's result row: a snippet centered on the match plus enough context
// (author, timestamp) to recognize the conversation moment.
export interface SessionSearchMatch {
  snippet: string;
  author: 'user' | 'assistant';
  ts: number;
}

// A session whose transcript matched the query. Title matching itself happens
// renderer-side over the session list; the sidecar only reports content hits.
export interface SessionSearchResult {
  appSessionId: string;
  matches: SessionSearchMatch[];
}

export interface HistorySearchReply {
  results: SessionSearchResult[];
  indexingIncomplete: boolean;
}

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export type BrowserViewportMode = 'fit' | 'desktop' | 'laptop' | 'tablet' | 'mobile' | 'custom';
export type BrowserScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface BrowserBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserElementRef {
  ref: string;
  selector: string;
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
  className?: string;
  box: BrowserBox;
  computedStyles?: Record<string, string>;
}

export interface BrowserState {
  browserSessionId: string;
  appSessionId?: string;
  url: string;
  title?: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
  screenshotPath?: string;
  screenshotUrl?: string;
  scroll: { x: number; y: number };
  refs: BrowserElementRef[];
  canGoBack?: boolean;
  canGoForward?: boolean;
  agentCursor?: { x: number; y: number };
  error?: string;
}

export interface BrowserNativeSnapshot {
  url: string;
  title?: string;
  scroll: { x: number; y: number };
  refs: BrowserElementRef[];
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface BrowserElementInspection {
  selector: string;
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  attributes: Record<string, string>;
  box: BrowserBox;
  html: string;
  iframe?: {
    src?: string;
    accessible: boolean;
  };
}

export interface BrowserNetworkEvent {
  timestamp: number;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  error?: string;
}

export interface BrowserConsoleEvent {
  timestamp: number;
  level: number;
  message: string;
  line?: number;
  source?: string;
}

export type BrowserNativeAction =
  | 'open'
  | 'reload'
  | 'goBack'
  | 'goForward'
  | 'snapshot'
  | 'click'
  | 'hover'
  | 'selectOption'
  | 'type'
  | 'keypress'
  | 'scroll'
  | 'resize'
  | 'inspect'
  | 'network'
  | 'console'
  | 'capture'
  | 'close'
  | 'fillCredentials';

export interface BrowserNativeRequest {
  requestId: string;
  appSessionId: string;
  browserSessionId: string;
  action: BrowserNativeAction;
  url?: string;
  viewport?: BrowserViewport;
  viewportMode?: BrowserViewportMode;
  x?: number;
  y?: number;
  selector?: string;
  text?: string;
  key?: string;
  direction?: BrowserScrollDirection;
  pixels?: number;
  box?: BrowserBox;
  fullPage?: boolean;
  deviceScaleFactor?: number;
  clearNetworkLog?: boolean;
  clearConsoleLog?: boolean;
}

export interface BrowserNativeResult {
  requestId: string;
  appSessionId: string;
  browserSessionId: string;
  ok: boolean;
  snapshot?: BrowserNativeSnapshot;
  inspection?: BrowserElementInspection;
  networkEvents?: BrowserNetworkEvent[];
  consoleEvents?: BrowserConsoleEvent[];
  image?: string;
  error?: string;
}

export interface ElementSource {
  framework?: 'react' | 'vue' | 'svelte' | 'unknown';
  component?: string;
  componentChain?: string[];
  file?: string;
  line?: number;
  column?: number;
  confidence: 'exact' | 'attribute' | 'heuristic' | 'none';
}

export interface DesignAnchorAncestor {
  tag: string;
  component?: string;
  selector?: string;
}

export interface DesignStrokePoint {
  x: number;
  y: number;
}

export interface DesignSelectionScreenshot {
  base64: string;
  box: BrowserBox;
}

export interface DesignAnchor {
  id: string;
  kind: 'element' | 'region' | 'text';
  label: string;
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  box: BrowserBox;
  source?: ElementSource;
  screenshotPath?: string;
  strokes?: DesignStrokePoint[][];
}

export interface DesignAnchorDetail {
  id: string;
  selector: string;
  selectorVerified: boolean;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  ancestors: DesignAnchorAncestor[];
  html?: string;
}

export interface DesignReference {
  id: string;
  anchor: DesignAnchor;
  detail?: DesignAnchorDetail;
  url: string;
  title?: string;
  viewport?: BrowserViewport;
  scroll?: { x: number; y: number };
  screenshot?: DesignSelectionScreenshot;
  createdAt?: string;
}

export type PermissionOutcome =
  | 'proceed_once'
  | 'proceed_always'
  | 'proceed_auto_run'
  | 'proceed_auto_run_low'
  | 'proceed_auto_run_medium'
  | 'proceed_auto_run_high'
  | 'proceed_new_session'
  | 'proceed_new_session_low'
  | 'proceed_new_session_medium'
  | 'proceed_new_session_high'
  | 'proceed_edit'
  | 'cancel';

type AssertClosedEnum<TUnion, TListed extends TUnion> =
  Exclude<TUnion, TListed> extends never
    ? true
    : ['missing enum members', Exclude<TUnion, TListed>];

export const INSTALL_CHANNELS = [
  'script',
  'brew',
  'npm',
] as const satisfies readonly InstallChannel[];
export const SESSION_PURPOSES = [
  'chat',
  'design',
  'mission-control',
] as const satisfies readonly SessionPurpose[];
export const RESPONSE_FORMATS = [
  'app-create',
  'app-followup',
] as const satisfies readonly ResponseFormat[];
export const PERMISSION_OUTCOMES = [
  'proceed_once',
  'proceed_always',
  'proceed_auto_run',
  'proceed_auto_run_low',
  'proceed_auto_run_medium',
  'proceed_auto_run_high',
  'proceed_new_session',
  'proceed_new_session_low',
  'proceed_new_session_medium',
  'proceed_new_session_high',
  'proceed_edit',
  'cancel',
] as const satisfies readonly PermissionOutcome[];
export const CONFIGURABLE_SESSION_ROLES = [
  'primary',
  'worker',
  'validator',
] as const satisfies readonly ConfigurableSessionRole[];
export const BROWSER_VIEWPORT_MODES = [
  'fit',
  'desktop',
  'laptop',
  'tablet',
  'mobile',
  'custom',
] as const satisfies readonly BrowserViewportMode[];
export const BROWSER_SCROLL_DIRECTIONS = [
  'up',
  'down',
  'left',
  'right',
] as const satisfies readonly BrowserScrollDirection[];
export const BACKGROUND_WORK_TIERS = [
  'interactive',
  'hidden',
  'low-power',
] as const satisfies readonly ('interactive' | 'hidden' | 'low-power')[];
export const BROWSER_INPUT_SOURCES = ['agent', 'user'] as const satisfies readonly (
  | 'agent'
  | 'user'
)[];
export const DESIGN_ANCHOR_KINDS = [
  'element',
  'region',
  'text',
] as const satisfies readonly DesignAnchor['kind'][];
export const ELEMENT_SOURCE_FRAMEWORKS = [
  'react',
  'vue',
  'svelte',
  'unknown',
] as const satisfies readonly NonNullable<ElementSource['framework']>[];
export const ELEMENT_SOURCE_CONFIDENCES = [
  'exact',
  'attribute',
  'heuristic',
  'none',
] as const satisfies readonly ElementSource['confidence'][];

const _installChannelsComplete = true satisfies AssertClosedEnum<
  InstallChannel,
  (typeof INSTALL_CHANNELS)[number]
>;
const _sessionPurposesComplete = true satisfies AssertClosedEnum<
  SessionPurpose,
  (typeof SESSION_PURPOSES)[number]
>;
const _responseFormatsComplete = true satisfies AssertClosedEnum<
  ResponseFormat,
  (typeof RESPONSE_FORMATS)[number]
>;
const _permissionOutcomesComplete = true satisfies AssertClosedEnum<
  PermissionOutcome,
  (typeof PERMISSION_OUTCOMES)[number]
>;
const _configurableSessionRolesComplete = true satisfies AssertClosedEnum<
  ConfigurableSessionRole,
  (typeof CONFIGURABLE_SESSION_ROLES)[number]
>;
const _browserViewportModesComplete = true satisfies AssertClosedEnum<
  BrowserViewportMode,
  (typeof BROWSER_VIEWPORT_MODES)[number]
>;
const _browserScrollDirectionsComplete = true satisfies AssertClosedEnum<
  BrowserScrollDirection,
  (typeof BROWSER_SCROLL_DIRECTIONS)[number]
>;
const _designAnchorKindsComplete = true satisfies AssertClosedEnum<
  DesignAnchor['kind'],
  (typeof DESIGN_ANCHOR_KINDS)[number]
>;
const _elementSourceFrameworksComplete = true satisfies AssertClosedEnum<
  NonNullable<ElementSource['framework']>,
  (typeof ELEMENT_SOURCE_FRAMEWORKS)[number]
>;
const _elementSourceConfidencesComplete = true satisfies AssertClosedEnum<
  ElementSource['confidence'],
  (typeof ELEMENT_SOURCE_CONFIDENCES)[number]
>;

// ── Frontend -> Sidecar ──────────────────────────────────────────────
export type ClientCommand =
  | McpClientCommand
  | { type: 'connect'; apiKey?: string }
  | { type: 'runtime.status' }
  | { type: 'auth.status' }
  | { type: 'env.detect' }
  | { type: 'cli.install'; channel: InstallChannel }
  | { type: 'cli.update'; channel?: InstallChannel }
  | { type: 'catalog.models' }
  | { type: 'catalog.tools'; appSessionId?: string; providerInstanceId?: ProviderInstanceId }
  | { type: 'catalog.skills'; appSessionId?: string; providerInstanceId?: ProviderInstanceId }
  | { type: 'settings.defaults' }
  | {
      type: 'session.create';
      clientRef: string;
      cwd?: string;
      title: string;
      goal: string;
      sessionPurpose: SessionPurpose;
      configuration: SessionConfiguration;
      droidMissionConfiguration?: DroidMissionConfiguration;
      compactionModel?: string;
      compactionTokenLimit?: number | null;
      compactionTokenLimitPerModel?: Record<string, number>;
      responseFormat?: ResponseFormat;
    }
  | { type: 'session.send'; appSessionId: string; text: string; responseFormat?: ResponseFormat }
  | { type: 'session.sendNow'; appSessionId: string; text: string; responseFormat?: ResponseFormat }
  | { type: 'session.resume'; appSessionId: string }
  | { type: 'session.interrupt'; appSessionId: string }
  | {
      type: 'session.updateSettings';
      appSessionId: string;
      configuration: SessionConfiguration;
    }
  | { type: 'session.compact'; appSessionId: string; customInstructions?: string }
  | { type: 'session.fork'; appSessionId: string }
  | { type: 'session.rename'; appSessionId: string; title: string }
  | {
      // Full-transcript Markdown export ("Copy as Markdown"). `title` is the
      // renderer's effective (possibly user-renamed) title for the header.
      type: 'session.exportMarkdown';
      appSessionId: string;
      requestId: string;
      title?: string;
    }
  | { type: 'sessions.reanchorCwd'; requestId: string; fromCwd: string; toCwd: string }
  | { type: 'session.rewindInfo'; appSessionId: string }
  | { type: 'session.rewind'; appSessionId: string; rewindId?: string }
  | { type: 'session.close'; appSessionId: string }
  | {
      type: 'sessions.list';
      workspaceCwds?: string[];
      includePlainChats?: boolean;
      // Workspaces whose pre-existing session bound the user lifted.
      revealEarlierCwds?: string[];
    }
  | { type: 'session.loadHistory'; appSessionId: string; cursor?: string; limit?: number }
  | { type: 'sessions.search'; requestId: string; query: string }
  | { type: 'history.indexingIdle'; isIdle: boolean }
  | {
      type: 'app.backgroundWork';
      tier: 'interactive' | 'hidden' | 'low-power';
      focusedAppSessionId?: string | null;
    }
  | {
      type: 'child.open';
      parentAppSessionId: string;
      childSessionId: string;
      requestId: string;
    }
  | {
      type: 'child.send';
      parentAppSessionId: string;
      childSessionId: string;
      text: string;
      responseFormat?: ResponseFormat;
    }
  | {
      type: 'child.sendNow';
      parentAppSessionId: string;
      childSessionId: string;
      text: string;
      responseFormat?: ResponseFormat;
    }
  | { type: 'child.interrupt'; parentAppSessionId: string; childSessionId: string }
  | {
      type: 'child.loadHistory';
      parentAppSessionId: string;
      childSessionId: string;
      cursor?: string;
      limit?: number;
    }
  | {
      type: 'child.updateSettings';
      parentAppSessionId: string;
      childSessionId: string;
      modelId: string | null;
      reasoningEffort?: ReasoningEffort;
    }
  | {
      type: 'approval.respond';
      appSessionId: string;
      requestId: string;
      outcome: PermissionOutcome;
    }
  | {
      type: 'question.respond';
      appSessionId: string;
      requestId: string;
      cancelled: boolean;
      answers: { index: number; question: string; answer: string }[];
    }
  | {
      type: 'settings.agent.update';
      appSessionId?: string;
      agent: ConfigurableSessionRole;
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort;
    }
  | {
      // Snapshot of the app's explicitly configured compaction limits. A null
      // global or empty per-model map means the user cleared that tier; omitted
      // fields continue following CLI-file defaults.
      type: 'settings.compaction.update';
      compactionTokenLimit?: number | null;
      compactionTokenLimitPerModel?: Record<string, number>;
    }
  | {
      type: 'browser.open';
      appSessionId: string;
      url: string;
      viewport?: BrowserViewport;
      viewportMode?: BrowserViewportMode;
    }
  | { type: 'browser.close'; appSessionId: string }
  | { type: 'browser.reload'; appSessionId: string }
  | { type: 'browser.refresh'; appSessionId: string }
  | {
      type: 'browser.resizeViewport';
      appSessionId: string;
      viewport: BrowserViewport;
      viewportMode: BrowserViewportMode;
    }
  | {
      type: 'browser.click';
      appSessionId: string;
      ref?: string;
      x?: number;
      y?: number;
      source?: 'agent' | 'user';
    }
  | { type: 'browser.type'; appSessionId: string; text: string }
  | { type: 'browser.keypress'; appSessionId: string; key: string }
  | {
      type: 'browser.scroll';
      appSessionId: string;
      direction: BrowserScrollDirection;
      pixels?: number;
      ref?: string;
      source?: 'agent' | 'user';
    }
  | {
      type: 'browser.screenshot';
      appSessionId: string;
      fullPage?: boolean;
      deviceScaleFactor?: number;
    }
  | { type: 'browser.inspectPoint'; appSessionId: string; x: number; y: number }
  | { type: 'browser.design.addReference'; appSessionId: string; reference: DesignReference }
  | {
      type: 'browser.design.sendPrompt';
      appSessionId: string;
      instruction: string;
      referenceIds: string[];
    }
  | { type: 'browser.native.result'; result: BrowserNativeResult };

export type ChildUpdatedEvent =
  | {
      type: 'child.updated';
      parentAppSessionId: string;
      childSessionId: string;
      requestId: string;
      access: 'ready';
      runtimeGeneration: number;
    }
  | {
      type: 'child.updated';
      parentAppSessionId: string;
      childSessionId: string;
      requestId: string;
      access: 'history';
    };

export interface SessionChildEvent {
  type: 'session.child';
  event: 'upserted';
  child: ChildSessionSummary;
  runtimeAvailable: boolean;
  runtimeGeneration: number;
}

export interface ChildErrorEvent {
  type: 'child.error';
  parentAppSessionId: string;
  childSessionId: string;
  operation: 'open' | 'loadHistory' | 'send' | 'sendNow' | 'interrupt' | 'settings';
  requestId: string | null;
  code: string;
  message: string;
  recoverable: boolean;
}

// ── Sidecar -> Frontend ──────────────────────────────────────────────
export type ServerEvent =
  | McpServerEvent
  | { type: 'connection'; status: 'connected' | 'error'; message?: string }
  | {
      type: 'runtime.updated';
      status: { mode: 'cli_auth'; droidPath: string; apiKeyConfigured: boolean };
    }
  | { type: 'env.report'; report: EnvironmentReport }
  | {
      type: 'cli.install.progress';
      phase: 'install' | 'update';
      stream: 'stdout' | 'stderr';
      line: string;
    }
  | { type: 'cli.install.done'; phase: 'install' | 'update'; ok: boolean; exitCode: number }
  | { type: 'session.created'; clientRef: string; session: SessionSummary }
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'session.closed'; appSessionId: string }
  | {
      type: 'sessions.cwdReanchored';
      requestId: string;
      ok: boolean;
      count: number;
      message?: string;
    }
  // "Copy as Markdown" reply: success and failure carry disjoint payloads.
  | {
      type: 'session.markdownExported';
      requestId: string;
      ok: true;
      markdown: string;
    }
  | {
      type: 'session.markdownExported';
      requestId: string;
      ok: false;
      message: string;
    }
  | ChildUpdatedEvent
  | ChildErrorEvent
  | { type: 'event.appended'; event: TranscriptEvent }
  | { type: 'approval.requested'; request: PermissionRequest }
  | { type: 'question.requested'; question: SessionQuestion }
  | {
      type: 'context.updated';
      appSessionId: string;
      sourceSessionId: string;
      parentAppSessionId?: string;
      childSessionId?: string;
      stats: ContextStatsSnapshot;
      breakdown?: unknown;
    }
  | {
      type: 'catalog.updated';
      catalog: 'models' | 'tools' | 'skills';
      items: unknown[];
      appSessionId?: string | null;
      providerInstanceId?: ProviderInstanceId | null;
    }
  | { type: 'settings.defaults'; defaults: FactoryDefaultSettings }
  | {
      type: 'error';
      code?: string;
      clientRef?: string;
      // Echoed from the offending command when it carried one, so requesters
      // can tell their own failure apart from a foreign command's.
      requestId?: string;
      appSessionId?: string;
      message: string;
      recoverable?: boolean;
    }
  | {
      type: 'mission.features';
      appSessionId: string;
      missionId?: string;
      features: BridgeFeature[];
    }
  | { type: 'mission.progress'; appSessionId: string; missionId?: string; entries: ProgressEntry[] }
  | SessionChildEvent
  | { type: 'spec.content'; appSessionId: string; path: string; content: string }
  | {
      type: 'sessions.list';
      sessions: SessionSummary[];
      // Pre-existing sessions withheld per requested cwd; a missing key means
      // the folder has nothing more to reveal.
      earlierSessionsByCwd: Record<string, number>;
    }
  | {
      type: 'session.history';
      appSessionId: string;
      childSessionId?: string;
      progress: ProgressEntry[];
      transcripts: TranscriptEvent[];
      childSessions?: ChildSessionSummary[];
      mode?: 'replace' | 'prepend';
      olderCursor?: string;
      // Restore telemetry: how many transcript events this page delivered and
      // whether older history remains to page in. Lets the client show an
      // explicit restoring/partial/complete state instead of guessing.
      loadedCount?: number;
      hasMore?: boolean;
    }
  | {
      type: 'session.history.error';
      appSessionId: string;
      childSessionId?: string;
      message: string;
    }
  | {
      type: 'sessions.searchResults';
      requestId: string;
      results: SessionSearchResult[];
      indexingIncomplete: boolean;
    }
  | { type: 'history.persistenceRecovered' }
  | { type: 'browser.updated'; state: BrowserState }
  | { type: 'browser.native.request'; request: BrowserNativeRequest }
  | { type: 'browser.closed'; appSessionId: string }
  | { type: 'browser.error'; appSessionId?: string; message: string };

export const BRIDGE_PROTOCOL_VERSION = 3 as const;

export interface SequencedServerEvent {
  seq: number;
  event: ServerEvent;
}

export interface ServerEventBatch {
  type: 'events.batch';
  generation: string;
  firstSeq: number;
  lastSeq: number;
  events: SequencedServerEvent[];
}

export interface PersistenceRecovery {
  durable: boolean;
  hadUnflushedWork: boolean;
  message?: string;
}

export interface InterruptedSessionRecord {
  appSessionId: string;
  childSessionId?: string;
  reason: string;
}

export interface BridgeRuntimeSnapshot {
  runtime: { mode: 'cli_auth'; droidPath: string; apiKeyConfigured: boolean };
  sessions: SessionSummary[];
  children: ChildSessionSummary[];
  persistence: PersistenceRecovery;
  interrupted: InterruptedSessionRecord[];
}

export interface BridgeResetMessage {
  type: 'bridge.reset';
  generation: string;
  lastSeq: number;
  reason: 'invalid_resume';
}

export interface BridgeSnapshotMessage {
  type: 'bridge.snapshot';
  generation: string;
  lastSeq: number;
  reason: 'generation_changed' | 'replay_unavailable';
  snapshot: BridgeRuntimeSnapshot;
}

export type ServerWireMessage =
  | Extract<ServerEvent, { type: 'error' }>
  | ServerEventBatch
  | BridgeResetMessage
  | BridgeSnapshotMessage;
