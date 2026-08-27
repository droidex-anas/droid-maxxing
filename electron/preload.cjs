const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function payloadBytes(payload) {
  if (!payload || typeof payload.data !== 'string') return 0;
  return Buffer.byteLength(payload.data, 'utf8');
}

const TERMINAL_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const TERMINAL_MAX_INPUT_BYTES = 32 * 1024;

function wrapTerminalPort(port) {
  const queued = [];
  let queuedBytes = 0;
  let droppedBytes = 0;
  let handler = null;

  function enqueue(payload) {
    const bytes = payloadBytes(payload);
    queued.push(payload);
    queuedBytes += bytes;
    while (queuedBytes > TERMINAL_MAX_QUEUED_BYTES && queued.length > 0) {
      let dropAt = queued.findIndex(
        (item) => item && (item.kind === 'data' || item.kind === 'replay'),
      );
      if (dropAt < 0) dropAt = 0;
      const [removed] = queued.splice(dropAt, 1);
      const removedBytes = payloadBytes(removed);
      queuedBytes = Math.max(0, queuedBytes - removedBytes);
      droppedBytes += removedBytes;
    }
  }

  function markTruncation() {
    if (droppedBytes <= 0) return;
    const first = queued.find((item) => item && (item.kind === 'data' || item.kind === 'replay'));
    if (first) {
      first.truncated = true;
      first.droppedBytes = (first.droppedBytes || 0) + droppedBytes;
    } else {
      queued.unshift({
        kind: 'data',
        data: '',
        sequence: 0,
        byteOffset: 0,
        truncated: true,
        droppedBytes,
      });
    }
    droppedBytes = 0;
  }

  port.addEventListener('message', (event) => {
    const payload = event.data;
    if (payload && (payload.kind === 'data' || payload.kind === 'replay')) {
      port.postMessage({
        type: 'ack',
        bytes: payloadBytes(payload),
        byteOffset: payload.byteOffset ?? payload.totalEmittedBytes ?? 0,
      });
    }
    if (handler) handler(payload);
    else enqueue(payload);
  });
  port.start();
  return {
    postInput(data) {
      if (typeof data !== 'string' || data.length === 0) return;
      if (Buffer.byteLength(data, 'utf8') > TERMINAL_MAX_INPUT_BYTES) return;
      try {
        port.postMessage({ type: 'input', data });
      } catch {
        // port already closed
      }
    },
    onEvent(next) {
      handler = next;
      markTruncation();
      if (queued.length > 0) {
        const pending = queued.splice(0);
        queuedBytes = 0;
        for (const payload of pending) next(payload);
      }
      return () => {
        if (handler === next) handler = null;
      };
    },
    close() {
      handler = null;
      queued.length = 0;
      queuedBytes = 0;
      droppedBytes = 0;
      try {
        port.close();
      } catch {
        // already closed
      }
    },
  };
}

function subscribeTerminalPort(id) {
  const { port1, port2 } = new MessageChannel();
  const channel = wrapTerminalPort(port2);
  ipcRenderer.postMessage('terminal-subscribe', { id }, [port1]);
  return channel;
}

contextBridge.exposeInMainWorld('droidControl', {
  bridgeInfo: () => ipcRenderer.invoke('bridge-info'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  saveImage: (dataUrl) => ipcRenderer.invoke('save-image', { dataUrl }),
  discardImage: (path) => ipcRenderer.invoke('discard-image', { path }),
  notify: (title, body, options) =>
    ipcRenderer.invoke('notify', {
      title,
      body,
      silent: options?.silent === true,
      appSessionId: typeof options?.appSessionId === 'string' ? options.appSessionId : undefined,
    }),
  onNotificationActivate: (handler) => on('notification-activate', handler),
  takePendingNotificationSession: () => ipcRenderer.invoke('notification-take-pending'),
  ackNotificationActivate: (appSessionId) =>
    ipcRenderer.invoke('notification-activate-ack', { appSessionId }),
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', { key }),
  clearApiKey: () => ipcRenderer.invoke('clear-api-key'),
  listFiles: (dir) => ipcRenderer.invoke('list-files', { dir }),
  getPerformanceMetrics: () => ipcRenderer.invoke('get-performance-metrics'),
  systemIdleTime: () => ipcRenderer.invoke('system-idle-time'),
  readFile: (path) => ipcRenderer.invoke('read-file', { path }),
  repoStatus: (dir) => ipcRenderer.invoke('repo-status', { dir }),
  listEditors: () => ipcRenderer.invoke('list-editors'),
  openProject: (dir, editor, target) => ipcRenderer.invoke('open-project', { dir, editor, target }),

  gitEnvironment: (dir) => ipcRenderer.invoke('git-environment', { dir }),
  gitBranches: (dir) => ipcRenderer.invoke('git-branches', { dir }),
  gitWorktrees: (dir) => ipcRenderer.invoke('git-worktrees', { dir }),
  gitDiffStat: (dir, options) => ipcRenderer.invoke('git-diff-stat', { dir, options }),
  gitDiffFiles: (dir, options) => ipcRenderer.invoke('git-diff-files', { dir, options }),
  gitFileDiff: (dir, options) => ipcRenderer.invoke('git-file-diff', { dir, options }),
  gitMarkTurnStart: (dir, ownerId) => ipcRenderer.invoke('git-mark-turn-start', { dir, ownerId }),
  gitAdoptTurnBaseline: (dir, clientRef, appSessionId) =>
    ipcRenderer.invoke('git-adopt-turn-baseline', { dir, clientRef, appSessionId }),
  gitCreateBranch: (dir, options) => ipcRenderer.invoke('git-create-branch', { dir, options }),
  gitCheckout: (dir, options) => ipcRenderer.invoke('git-checkout', { dir, options }),
  gitCreateWorktree: (dir, options) => ipcRenderer.invoke('git-create-worktree', { dir, options }),
  gitRemoveWorktree: (dir, options) => ipcRenderer.invoke('git-remove-worktree', { dir, options }),
  gitCommit: (dir, options) => ipcRenderer.invoke('git-commit', { dir, options }),
  gitPush: (dir, options) => ipcRenderer.invoke('git-push', { dir, options }),
  gitFetch: (dir) => ipcRenderer.invoke('git-fetch', { dir }),

  githubAvailable: () => ipcRenderer.invoke('github-available'),
  githubInstall: () => ipcRenderer.invoke('github-install'),
  githubAuthenticate: () => ipcRenderer.invoke('github-authenticate'),
  githubCancelSetup: () => ipcRenderer.invoke('github-cancel-setup'),
  onGithubAuthCode: (handler) => on('github-auth-code', handler),
  githubDetectPr: (dir, options) => ipcRenderer.invoke('github-detect-pr', { dir, options }),
  githubListPrs: (dir, options) => ipcRenderer.invoke('github-list-prs', { dir, options }),
  githubViewPr: (dir, options) => ipcRenderer.invoke('github-view-pr', { dir, options }),
  githubPrDiff: (dir, options) => ipcRenderer.invoke('github-pr-diff', { dir, options }),
  githubPrChecks: (dir, options) => ipcRenderer.invoke('github-pr-checks', { dir, options }),
  githubPrComments: (dir, options) => ipcRenderer.invoke('github-pr-comments', { dir, options }),
  githubCreatePr: (dir, options) => ipcRenderer.invoke('github-create-pr', { dir, options }),
  githubPostComment: (dir, options) => ipcRenderer.invoke('github-post-comment', { dir, options }),
  githubMergePr: (dir, options) => ipcRenderer.invoke('github-merge-pr', { dir, options }),

  getOnboarding: () => ipcRenderer.invoke('onboarding-get'),
  setOnboarding: (patch) => ipcRenderer.invoke('onboarding-set', { patch }),
  appVersion: () => ipcRenderer.invoke('app-version'),
  checkAppUpdate: (options) => ipcRenderer.invoke('app-check-update', options),
  downloadAppUpdate: () => ipcRenderer.invoke('app-download-update'),
  submitFeedbackReport: (report) => ipcRenderer.invoke('feedback-report', report),
  getAutomaticDiagnostics: () => ipcRenderer.invoke('diagnostics-preference-get'),
  setAutomaticDiagnostics: (enabled) =>
    ipcRenderer.invoke('diagnostics-preference-set', { enabled }),
  getHardwareAcceleration: () => ipcRenderer.invoke('hardware-acceleration-preference-get'),
  setHardwareAcceleration: (enabled) =>
    ipcRenderer.invoke('hardware-acceleration-preference-set', { enabled }),
  relaunchApp: () => ipcRenderer.invoke('app-relaunch'),
  setAppIcon: (mode) => ipcRenderer.invoke('app-set-icon', { mode }),
  openExternal: (url) => ipcRenderer.invoke('open-external', { url }),

  terminalCreate: (options) => ipcRenderer.invoke('terminal-create', options),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke('terminal-resize', { id, cols, rows }),
  terminalKill: (id) => ipcRenderer.invoke('terminal-kill', { id }),
  terminalList: (appSessionId) => ipcRenderer.invoke('terminal-list', { appSessionId }),
  terminalSubscribe: (id) => subscribeTerminalPort(id),
  terminalUnsubscribe: (id) => ipcRenderer.invoke('terminal-unsubscribe', { id }),
  filesAuthorizeRoot: (root) => ipcRenderer.invoke('files-authorize-root', { root }),
  filesList: (accessToken, relative) => ipcRenderer.invoke('files-list', { accessToken, relative }),
  filesPreview: (accessToken, relative) =>
    ipcRenderer.invoke('files-preview', { accessToken, relative }),
  filesOpen: (accessToken, relative) => ipcRenderer.invoke('files-open', { accessToken, relative }),
  filesReveal: (accessToken, relative) =>
    ipcRenderer.invoke('files-reveal', { accessToken, relative }),

  nativeBrowserOpen: (browserSessionId, url, bounds, viewport) =>
    ipcRenderer.invoke('native-browser-open', { browserSessionId, url, bounds, viewport }),
  nativeBrowserAttach: (browserSessionId, bounds, url) =>
    ipcRenderer.invoke('native-browser-attach', { browserSessionId, bounds, url }),
  nativeBrowserDetach: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-detach', { browserSessionId }),
  nativeBrowserSetBounds: (browserSessionId, bounds) =>
    ipcRenderer.invoke('native-browser-set-bounds', { browserSessionId, bounds }),
  nativeBrowserSetVisible: (browserSessionId, visible) =>
    ipcRenderer.invoke('native-browser-visible', { browserSessionId, visible }),
  nativeBrowserClose: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-close', { browserSessionId }),
  nativeBrowserReload: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-reload', { browserSessionId }),
  nativeBrowserGoBack: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-go-back', { browserSessionId }),
  nativeBrowserGoForward: (browserSessionId) =>
    ipcRenderer.invoke('native-browser-go-forward', { browserSessionId }),
  nativeBrowserSetDesignMode: (browserSessionId, active) =>
    ipcRenderer.invoke('native-browser-set-design-mode', { browserSessionId, active }),
  nativeBrowserSetPencilMode: (browserSessionId, active) =>
    ipcRenderer.invoke('native-browser-set-pencil-mode', { browserSessionId, active }),
  nativeBrowserAgentAction: (request) =>
    ipcRenderer.invoke('native-browser-agent-action', { request }),
  nativeBrowserCapture: (browserSessionId, box, options) =>
    ipcRenderer.invoke('native-browser-capture', { browserSessionId, box, options }),

  onNativeBrowserSelection: (handler) => on('native-browser-selection', handler),
  onNativeBrowserDesignPrompt: (handler) => on('native-browser-design-prompt', handler),
  onNativeBrowserLoaded: (handler) => on('native-browser-loaded', handler),
  onNativeBrowserLoadFailed: (handler) => on('native-browser-load-failed', handler),
  onNativeBrowserAgentResult: (handler) => on('native-browser-agent-result', handler),
});
