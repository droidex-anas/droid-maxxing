import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const port = Number(process.env.BRIDGE_PORT);
const token = process.env.BRIDGE_TOKEN ?? '';
const logPath = process.env.CHILD_SESSIONS_SMOKE_LOG;
const allowAnyToken = process.env.CHILD_SESSIONS_SMOKE_ALLOW_ANY_TOKEN === '1';
const streamEventCount = Number(process.env.CHILD_SESSIONS_SMOKE_STREAM_EVENTS ?? '0');
const bridgeProtocolVersion = '3';
const bridgeGeneration = `child-session-smoke-${String(process.pid)}`;
let nextBridgeSequence = 1;

if (
  !Number.isSafeInteger(port) ||
  port < 0 ||
  port > 65_535 ||
  (!token && !allowAnyToken) ||
  !logPath
) {
  throw new Error(
    'Child-session smoke fixture requires BRIDGE_PORT, bridge authentication, and log path.',
  );
}

const now = Date.now();
const session = (appSessionId, title, updatedAt) => ({
  appSessionId,
  providerSessionId: `provider-${appSessionId}`,
  sessionPurpose: 'chat',
  interactionMode: 'auto',
  role: 'primary',
  title,
  goal: `${title} goal`,
  cwd: '',
  workspaceKind: 'none',
  modelId: 'model-primary',
  reasoningEffort: 'medium',
  autonomy: 'medium',
  phase: 'paused',
  streaming: false,
  features: [],
  tokensIn: 10,
  tokensOut: 20,
  contextTokens: 30,
  createdAt: updatedAt - 1_000,
  updatedAt,
});

const parents = [
  session('parent-alpha', 'Parent Alpha', now + 2_000),
  session('parent-beta', 'Parent Beta', now + 1_000),
];

const child = (parentAppSessionId, childSessionId, label, status, transcriptAvailable = true) => ({
  parentAppSessionId,
  childSessionId,
  role: 'worker',
  status,
  label,
  prompt: `${label} prompt`,
  modelId: 'model-child',
  reasoningEffort: 'high',
  spawnLink: { kind: 'tool-use', id: `tool-${parentAppSessionId}-${childSessionId}` },
  transcriptAvailable,
  startedAt: now - 5_000,
});

const children = {
  'parent-alpha': [
    child('parent-alpha', 'shared-child', 'Alpha Worker Shared', 'running'),
    child('parent-alpha', 'alpha-sibling', 'Alpha Worker Two', 'running'),
    child('parent-alpha', 'alpha-history', 'Alpha Historical Worker', 'completed'),
  ],
  'parent-beta': [child('parent-beta', 'shared-child', 'Beta Worker Shared', 'running')],
};

const transcriptEvent = (appSessionId, id, sourceSessionId, role, text, ts, author) => ({
  id,
  appSessionId,
  sourceSessionId,
  role,
  ts,
  kind: 'text',
  text,
  ...(author ? { author } : {}),
});

const alphaSiblingHistory = Array.from({ length: 180 }, (_, index) => {
  const number = index + 1;
  const suffix =
    number === 180
      ? 'ALPHA CHILD TWO OUTPUT'
      : `ALPHA CHILD HISTORY ${String(number).padStart(4, '0')}`;
  return transcriptEvent(
    'parent-alpha',
    `alpha-sibling-${String(number).padStart(4, '0')}`,
    'alpha-sibling',
    'worker',
    `${suffix}\n${'history detail '.repeat((number % 4) + 1).trim()}`,
    now - 3_700 + number,
  );
});

const alphaHistoricalHistory = Array.from({ length: 900 }, (_, index) => {
  const number = index + 1;
  return transcriptEvent(
    'parent-alpha',
    `alpha-history-${String(number).padStart(4, '0')}`,
    'alpha-history',
    'worker',
    number === 900 ? 'ALPHA HISTORICAL OUTPUT' : `ALPHA HISTORICAL ${String(number)}`,
    now - 3_600 + number,
  );
});

const transcripts = {
  'parent-alpha': [
    transcriptEvent(
      'parent-alpha',
      'alpha-user',
      'user',
      'primary',
      'ALPHA PRIMARY PROMPT',
      now - 4_000,
      'user',
    ),
    transcriptEvent(
      'parent-alpha',
      'alpha-primary',
      'parent-alpha',
      'primary',
      'ALPHA PRIMARY OUTPUT',
      now - 3_900,
    ),
    transcriptEvent(
      'parent-alpha',
      'alpha-shared-output',
      'shared-child',
      'worker',
      'ALPHA SHARED CHILD OUTPUT',
      now - 3_800,
    ),
    ...alphaSiblingHistory,
    ...alphaHistoricalHistory,
  ],
  'parent-beta': [
    transcriptEvent(
      'parent-beta',
      'beta-primary',
      'parent-beta',
      'primary',
      'BETA PRIMARY OUTPUT',
      now - 2_000,
    ),
    transcriptEvent(
      'parent-beta',
      'beta-shared-output',
      'shared-child',
      'worker',
      'BETA SHARED CHILD OUTPUT',
      now - 1_900,
    ),
  ],
};

function record(value) {
  appendFileSync(logPath, `${JSON.stringify({ receivedAt: Date.now(), ...value })}\n`);
}

record({
  type: 'fixture.start',
  factoryApiKeyConfigured: Boolean(process.env.FACTORY_API_KEY),
  droidPathConfigured: Boolean(process.env.DROID_PATH),
});

const server = new WebSocketServer({ host: '127.0.0.1', port });
const timers = new Set();
const streamingSockets = new WeakSet();

function send(socket, event) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const seq = nextBridgeSequence;
  nextBridgeSequence += 1;
  socket.send(
    JSON.stringify({
      type: 'events.batch',
      generation: bridgeGeneration,
      firstSeq: seq,
      lastSeq: seq,
      events: [{ seq, event }],
    }),
  );
}

function history(socket, appSessionId) {
  const primaryTranscript = (transcripts[appSessionId] ?? []).filter(
    (event) => event.sourceSessionId === 'user' || event.sourceSessionId === appSessionId,
  );
  send(socket, {
    type: 'session.history',
    appSessionId,
    progress: [],
    transcripts: primaryTranscript,
    childSessions: children[appSessionId] ?? [],
    mode: 'replace',
    loadedCount: primaryTranscript.length,
    hasMore: false,
  });
}

function childHistory(socket, command) {
  const childTranscript = (transcripts[command.parentAppSessionId] ?? []).filter(
    (event) => event.sourceSessionId === command.childSessionId,
  );
  const requestedLimit =
    Number.isSafeInteger(command.limit) && command.limit > 0 ? command.limit : undefined;
  const pageSize =
    command.childSessionId === 'alpha-sibling'
      ? Math.min(60, requestedLimit ?? 60)
      : Math.min(childTranscript.length, requestedLimit ?? childTranscript.length);
  const cursorPrefix = 'alpha-sibling:';
  const cursorOffset =
    typeof command.cursor === 'string' && command.cursor.startsWith(cursorPrefix)
      ? Number.parseInt(command.cursor.slice(cursorPrefix.length), 10)
      : childTranscript.length;
  const pageEnd = Number.isSafeInteger(cursorOffset)
    ? Math.max(0, Math.min(childTranscript.length, cursorOffset))
    : childTranscript.length;
  const pageStart = Math.max(0, pageEnd - pageSize);
  const page = childTranscript.slice(pageStart, pageEnd);
  const olderCursor =
    command.childSessionId === 'alpha-sibling' && pageStart > 0
      ? `${cursorPrefix}${String(pageStart)}`
      : undefined;
  const deliver = () =>
    send(socket, {
      type: 'session.history',
      appSessionId: command.parentAppSessionId,
      childSessionId: command.childSessionId,
      progress: [],
      transcripts: page,
      mode: command.cursor ? 'prepend' : 'replace',
      olderCursor,
      loadedCount: page.length,
      hasMore: Boolean(olderCursor),
    });
  if (!command.cursor) {
    deliver();
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    deliver();
  }, 150);
  timers.add(timer);
}

function startChildStream(socket, command) {
  if (
    command.parentAppSessionId !== 'parent-alpha' ||
    command.childSessionId !== 'alpha-sibling' ||
    !Number.isSafeInteger(streamEventCount) ||
    streamEventCount <= 0 ||
    streamingSockets.has(socket)
  ) {
    return;
  }
  streamingSockets.add(socket);
  let index = 0;
  const timer = setInterval(() => {
    index += 1;
    send(socket, {
      type: 'event.appended',
      event: transcriptEvent(
        'parent-alpha',
        `alpha-stream-${String(index).padStart(4, '0')}`,
        'alpha-sibling',
        'worker',
        `STREAMING OUTPUT ${String(index)}`,
        Date.now(),
      ),
    });
    if (index >= streamEventCount) {
      clearInterval(timer);
      timers.delete(timer);
    }
  }, 25);
  timers.add(timer);
}

function openChild(socket, command) {
  const summary = children[command.parentAppSessionId]?.find(
    (candidate) => candidate.childSessionId === command.childSessionId,
  );
  childHistory(socket, command);
  if (!summary || summary.status === 'completed') {
    send(socket, {
      type: 'child.updated',
      parentAppSessionId: command.parentAppSessionId,
      childSessionId: command.childSessionId,
      requestId: command.requestId,
      access: 'history',
    });
    return;
  }
  startChildStream(socket, command);
  const reply = () =>
    send(socket, {
      type: 'child.updated',
      parentAppSessionId: command.parentAppSessionId,
      childSessionId: command.childSessionId,
      requestId: command.requestId,
      access: 'ready',
      runtimeGeneration: command.childSessionId === 'shared-child' ? 7 : 11,
    });
  if (command.parentAppSessionId === 'parent-alpha' && command.childSessionId === 'shared-child') {
    const timer = setTimeout(() => {
      timers.delete(timer);
      reply();
      send(socket, {
        type: 'event.appended',
        event: transcriptEvent(
          'parent-alpha',
          'stale-open-processed',
          'alpha-sibling',
          'worker',
          'STALE OPEN PROCESSED',
          Date.now(),
        ),
      });
    }, 500);
    timers.add(timer);
  } else {
    reply();
  }
}

server.on('connection', (socket, request) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const provided = requestUrl.searchParams.get('token');
  if (!allowAnyToken && provided !== token) {
    socket.close(1008, 'invalid bridge token');
    return;
  }
  if (requestUrl.searchParams.get('bridgeProtocol') !== bridgeProtocolVersion) {
    socket.close(1002, 'unsupported bridge protocol');
    return;
  }
  send(socket, { type: 'connection', status: 'connected' });
  socket.on('message', (raw) => {
    const command = JSON.parse(String(raw));
    record(command);
    switch (command.type) {
      case 'connect':
      case 'runtime.status':
        send(socket, {
          type: 'runtime.updated',
          status: { mode: 'cli_auth', droidPath: '', apiKeyConfigured: false },
        });
        break;
      case 'env.detect':
        send(socket, {
          type: 'env.report',
          report: {
            platform: process.platform,
            arch: process.arch,
            osVersion: 'local-smoke',
            node: { present: true, version: process.version },
            cli: { present: true, path: '/local-smoke/droid', version: 'smoke' },
            packageManagers: {},
            auth: { apiKeyConfigured: false, loginPresent: true },
            availableChannels: [],
          },
        });
        break;
      case 'settings.defaults':
        send(socket, { type: 'settings.defaults', defaults: {} });
        break;
      case 'sessions.list':
        send(socket, { type: 'sessions.list', sessions: parents });
        break;
      case 'session.loadHistory':
        history(socket, command.appSessionId);
        break;
      case 'child.loadHistory':
        childHistory(socket, command);
        break;
      case 'child.open':
        openChild(socket, command);
        break;
      case 'catalog.models':
        send(socket, {
          type: 'catalog.updated',
          catalog: 'models',
          items: [
            {
              id: 'model-child',
              displayName: 'Child Model',
              isCustom: false,
              supportedReasoningEfforts: ['high'],
              defaultReasoningEffort: 'high',
            },
          ],
        });
        break;
    }
  });
});

server.on('listening', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no TCP address.');
  process.stdout.write(`SIDECAR_READY ${String(address.port)}\n`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const timer of timers) clearTimeout(timer);
  for (const client of server.clients) client.terminate();
  server.close(() => process.exit(0));
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
if (process.env.BRIDGE_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.resume();
  process.stdin.once('end', shutdown);
}
