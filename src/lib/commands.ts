import { bridge } from './bridge';
import { isAppUpdateInstalling } from './appUpdate';
import type {
  BrowserNativeResult,
  BrowserScrollDirection,
  BrowserViewport,
  BrowserViewportMode,
  ConfigurableSessionRole,
  DesignReference,
  DroidMissionConfiguration,
  InstallChannel,
  McpServerInput,
  PermissionOutcome,
  ReasoningEffort,
  ResponseFormat,
  SessionConfiguration,
  SessionPurpose,
} from '../types/bridge';

let refCounter = 0;

function requireAgentWorkAvailable(): void {
  if (isAppUpdateInstalling()) {
    throw new Error('DROIDEX is installing an update; new agent work is paused until restart.');
  }
}

export const newClientRef = () => `c-${Date.now().toString(36)}-${String(refCounter++)}`;

export const connect = (apiKey: string) => {
  bridge.send({ type: 'connect', apiKey });
};

export const createSession = (input: {
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
}) => {
  requireAgentWorkAvailable();
  bridge.send({ type: 'session.create', ...input });
};

export const updateSessionSettings = (input: {
  appSessionId: string;
  configuration: SessionConfiguration;
}) => {
  bridge.send({ type: 'session.updateSettings', ...input });
};

export const detectEnv = () => {
  bridge.send({ type: 'env.detect' });
};
export const installCli = (channel: InstallChannel) => {
  bridge.send({ type: 'cli.install', channel });
};
export const updateCli = (channel?: InstallChannel) => {
  bridge.send({ type: 'cli.update', channel });
};
export const requestRuntimeStatus = () => {
  bridge.send({ type: 'runtime.status' });
};

export const listModels = () => {
  bridge.send({ type: 'catalog.models' });
};
export const listSkills = (appSessionId?: string) => {
  bridge.send({ type: 'catalog.skills', appSessionId });
};
export const listMcpServers = (requestId: string, cwd?: string) => {
  bridge.send({ type: 'mcp.list', requestId, ...(cwd ? { cwd } : {}) });
};
export const addMcpServer = (requestId: string, server: McpServerInput, cwd?: string) => {
  bridge.send({ type: 'mcp.add', requestId, server, ...(cwd ? { cwd } : {}) });
};
export const removeMcpServer = (requestId: string, serverName: string, cwd?: string) => {
  bridge.send({ type: 'mcp.remove', requestId, serverName, ...(cwd ? { cwd } : {}) });
};
export const toggleMcpServer = (
  requestId: string,
  serverName: string,
  enabled: boolean,
  cwd?: string,
) => {
  bridge.send({ type: 'mcp.toggle', requestId, serverName, enabled, ...(cwd ? { cwd } : {}) });
};
export const authenticateMcpServer = (requestId: string, serverName: string, cwd?: string) => {
  bridge.send({ type: 'mcp.authenticate', requestId, serverName, ...(cwd ? { cwd } : {}) });
};
export const listFactoryDefaults = () => {
  bridge.send({ type: 'settings.defaults' });
};

export const sendToSession = (
  appSessionId: string,
  text: string,
  responseFormat?: ResponseFormat,
) => {
  requireAgentWorkAvailable();
  bridge.send({
    type: 'session.send',
    appSessionId,
    text,
    ...(responseFormat ? { responseFormat } : {}),
  });
};

export const sendToSessionNow = (
  appSessionId: string,
  text: string,
  responseFormat?: ResponseFormat,
) => {
  requireAgentWorkAvailable();
  bridge.send({
    type: 'session.sendNow',
    appSessionId,
    text,
    ...(responseFormat ? { responseFormat } : {}),
  });
};

export const sendToChild = (
  parentAppSessionId: string,
  childSessionId: string,
  text: string,
  responseFormat?: ResponseFormat,
) => {
  requireAgentWorkAvailable();
  bridge.send({
    type: 'child.send',
    parentAppSessionId,
    childSessionId,
    text,
    ...(responseFormat ? { responseFormat } : {}),
  });
};

export const sendToChildNow = (
  parentAppSessionId: string,
  childSessionId: string,
  text: string,
  responseFormat?: ResponseFormat,
) => {
  requireAgentWorkAvailable();
  bridge.send({
    type: 'child.sendNow',
    parentAppSessionId,
    childSessionId,
    text,
    ...(responseFormat ? { responseFormat } : {}),
  });
};

export const respondPermission = (
  appSessionId: string,
  requestId: string,
  outcome: PermissionOutcome,
) => {
  bridge.send({ type: 'approval.respond', appSessionId, requestId, outcome });
};

export const respondQuestion = (
  appSessionId: string,
  requestId: string,
  cancelled: boolean,
  answers: { index: number; question: string; answer: string }[],
) => {
  bridge.send({ type: 'question.respond', appSessionId, requestId, cancelled, answers });
};

export const interruptSession = (appSessionId: string) => {
  bridge.send({ type: 'session.interrupt', appSessionId });
};

export const compactSession = (appSessionId: string, customInstructions?: string) => {
  bridge.send({ type: 'session.compact', appSessionId, customInstructions });
};

export const interruptChild = (parentAppSessionId: string, childSessionId: string) => {
  bridge.send({
    type: 'child.interrupt',
    parentAppSessionId,
    childSessionId,
  });
};

export const interruptVisibleSession = (
  parentAppSessionId: string,
  childSessionId?: string | null,
) => {
  if (childSessionId) {
    interruptChild(parentAppSessionId, childSessionId);
  } else {
    interruptSession(parentAppSessionId);
  }
};

let childOpenRequestCounter = 0;
export const newChildOpenRequestId = () =>
  `child-open-${Date.now().toString(36)}-${(childOpenRequestCounter++).toString(36)}`;

export const openChild = (
  parentAppSessionId: string,
  childSessionId: string,
  requestId: string,
) => {
  bridge.send({ type: 'child.open', parentAppSessionId, childSessionId, requestId });
};

export const closeSession = (appSessionId: string) => {
  bridge.send({ type: 'session.close', appSessionId });
};

// Best-effort sync of a chat rename to the harness's own session title. The
// app-level displayTitle (lib/chatMetadata) stays the UI source of truth, so
// a failure here only means other clients keep the generated title.
export const renameSession = (appSessionId: string, title: string) => {
  bridge.send({ type: 'session.rename', appSessionId, title });
};

// Full chat transcript rendered as Markdown by the sidecar, which reads the
// stored session file from disk — so the export is complete even for a chat
// that was never opened in this app run.
export const exportSessionMarkdown = (appSessionId: string, title: string): Promise<string> => {
  const requestId = newClientRef();
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out while exporting the chat.'));
    }, 10_000);
    const unsubscribe = bridge.subscribe((event) => {
      // A sidecar older than this renderer answers unknown commands with
      // bridge.unsupported_command instead of the awaited reply; fail the
      // export immediately rather than waiting out the timeout. Only the
      // event echoing this request's id is ours — a foreign unsupported
      // command failing concurrently must not reject this export.
      if (
        event.type === 'error' &&
        event.code === 'bridge.unsupported_command' &&
        event.requestId === requestId
      ) {
        globalThis.clearTimeout(timeout);
        unsubscribe();
        // The code rides along so the caller can skip its own toast: the
        // global bridge subscriber already surfaced the skew error.
        reject(Object.assign(new Error(event.message), { code: event.code }));
        return;
      }
      if (event.type !== 'session.markdownExported' || event.requestId !== requestId) return;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      if (event.ok) resolve(event.markdown);
      else reject(new Error(event.message));
    });
    if (
      !bridge.sendIfConnected({ type: 'session.exportMarkdown', appSessionId, requestId, title })
    ) {
      globalThis.clearTimeout(timeout);
      unsubscribe();
      reject(new Error('Reconnect to DROIDEX before exporting a chat.'));
    }
  });
};

export const reanchorSessionsForWorktreeRemoval = (
  fromCwd: string,
  toCwd: string,
): Promise<number> => {
  const requestId = newClientRef();
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out while updating sessions that used this worktree.'));
    }, 10_000);
    const unsubscribe = bridge.subscribe((event) => {
      if (event.type !== 'sessions.cwdReanchored' || event.requestId !== requestId) return;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      if (event.ok) resolve(event.count);
      else reject(new Error(event.message ?? 'Could not update sessions that used this worktree.'));
    });
    if (!bridge.sendIfConnected({ type: 'sessions.reanchorCwd', requestId, fromCwd, toCwd })) {
      globalThis.clearTimeout(timeout);
      unsubscribe();
      reject(new Error('Reconnect to DROIDEX before removing a worktree.'));
    }
  });
};

export const listSessions = (options?: {
  workspaceCwds?: string[];
  includePlainChats?: boolean;
  revealEarlierCwds?: string[];
}) => {
  bridge.send({ type: 'sessions.list', ...options });
};

export const loadSessionHistory = (appSessionId: string, cursor?: string, limit?: number) => {
  bridge.send({ type: 'session.loadHistory', appSessionId, cursor, limit });
};

export const loadChildHistory = (
  parentAppSessionId: string,
  childSessionId: string,
  cursor?: string,
  limit?: number,
) => {
  bridge.send({
    type: 'child.loadHistory',
    parentAppSessionId,
    childSessionId,
    cursor,
    limit,
  });
};

// Transcript content search; the matching sessions.searchResults event
// carries the same requestId so callers can drop stale responses.
export const searchSessions = (requestId: string, query: string) => {
  bridge.send({ type: 'sessions.search', requestId, query });
};

export const setHistoryIndexingIdle = (isIdle: boolean) => {
  return bridge.sendIfConnected({ type: 'history.indexingIdle', isIdle });
};

export const setBackgroundWork = (
  tier: 'interactive' | 'hidden' | 'low-power',
  focusedAppSessionId?: string | null,
) => {
  return bridge.sendIfConnected({ type: 'app.backgroundWork', tier, focusedAppSessionId });
};

export const updateAgentSettings = (input: {
  appSessionId?: string;
  agent: ConfigurableSessionRole;
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
}) => {
  bridge.send({ type: 'settings.agent.update', ...input });
};

export const updateChildSettings = (input: {
  parentAppSessionId: string;
  childSessionId: string;
  modelId: string | null;
  reasoningEffort?: ReasoningEffort;
}) => {
  bridge.send({ type: 'child.updateSettings', ...input });
};

export const updateCompactionSettings = (input: {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
}) => {
  bridge.send({ type: 'settings.compaction.update', ...input });
};

export const openBrowser = (input: {
  appSessionId: string;
  url: string;
  viewport?: BrowserViewport;
  viewportMode?: BrowserViewportMode;
}) => {
  bridge.send({ type: 'browser.open', ...input });
};

export const closeBrowser = (appSessionId: string) => {
  bridge.send({ type: 'browser.close', appSessionId });
};

export const reloadBrowser = (appSessionId: string) => {
  bridge.send({ type: 'browser.reload', appSessionId });
};

export const refreshBrowser = (appSessionId: string) => {
  bridge.send({ type: 'browser.refresh', appSessionId });
};

export const resizeBrowserViewport = (input: {
  appSessionId: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
}) => {
  bridge.send({ type: 'browser.resizeViewport', ...input });
};

export const clickBrowser = (input: {
  appSessionId: string;
  ref?: string;
  x?: number;
  y?: number;
  source?: 'agent' | 'user';
}) => {
  bridge.send({ type: 'browser.click', ...input });
};

export const typeBrowser = (appSessionId: string, text: string) => {
  bridge.send({ type: 'browser.type', appSessionId, text });
};

export const keypressBrowser = (appSessionId: string, key: string) => {
  bridge.send({ type: 'browser.keypress', appSessionId, key });
};

export const scrollBrowser = (input: {
  appSessionId: string;
  direction: BrowserScrollDirection;
  pixels?: number;
  ref?: string;
  source?: 'agent' | 'user';
}) => {
  bridge.send({ type: 'browser.scroll', ...input });
};

export const addDesignReference = (appSessionId: string, reference: DesignReference) => {
  bridge.send({ type: 'browser.design.addReference', appSessionId, reference });
};

export const sendDesignPrompt = (
  appSessionId: string,
  instruction: string,
  referenceIds: string[],
) => {
  bridge.send({
    type: 'browser.design.sendPrompt',
    appSessionId,
    instruction,
    referenceIds,
  });
};

export const sendNativeBrowserResult = (result: BrowserNativeResult) => {
  bridge.send({ type: 'browser.native.result', result });
};
