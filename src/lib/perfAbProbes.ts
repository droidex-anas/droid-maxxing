import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Virtualizer } from '@tanstack/virtual-core';

export interface AbProbeMetric {
  id: string;
  value: number;
  unit: string;
  method: string;
}

export interface AbProbeResult {
  treeRoot: string;
  metrics: AbProbeMetric[];
  notes: string[];
}

export const HISTORY_10K = 10_000;
export const TERMINAL_FLOOD_CHUNKS = 1_000;
export const TERMINAL_CHUNK = 'x'.repeat(64);
export const STREAM_DELTAS = 40;
export const STREAM_PREFIX_EVENTS = 200;

export async function runAbProbes(treeRoot: string): Promise<AbProbeResult> {
  const notes: string[] = [];
  const metrics: AbProbeMetric[] = [];

  const bundle = measureBundle(treeRoot);
  if (bundle) metrics.push(...bundle);
  else notes.push('dist/ missing or unreadable; bundle metrics unmeasured.');

  metrics.push(await measureMountedRows(treeRoot, HISTORY_10K));
  metrics.push(...(await measureFeedProjection(treeRoot)));
  metrics.push(await measureMarkdown(treeRoot));
  metrics.push(await measureTerminalFlood(treeRoot));

  return { treeRoot, metrics, notes };
}

export function measureBundle(treeRoot: string): AbProbeMetric[] | null {
  const distDir = join(treeRoot, 'dist');
  const assetsDir = join(distDir, 'assets');
  const htmlPath = join(distDir, 'index.html');
  if (!existsSync(htmlPath) || !existsSync(assetsDir)) return null;
  const html = readFileSync(htmlPath, 'utf8');
  const scriptMatch = html.match(/<script[^>]+src="\.\/assets\/([^"]+\.js)"/);
  const cssMatch = html.match(/<link[^>]+href="\.\/assets\/([^"]+\.css)"/);
  if (!scriptMatch || !cssMatch) return null;
  const entryJs = join(assetsDir, scriptMatch[1]);
  const entryCss = join(assetsDir, cssMatch[1]);
  const jsChunks = readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(assetsDir, name));
  const totalJs = jsChunks.reduce((sum, path) => sum + statSync(path).size, 0);
  return [
    metric(
      'bundle.initialJsBytes',
      statSync(entryJs).size,
      'bytes',
      'dist/index.html entry script',
    ),
    metric('bundle.initialCssBytes', statSync(entryCss).size, 'bytes', 'dist/index.html entry css'),
    metric('bundle.totalJsBytes', totalJs, 'bytes', 'sum of dist/assets/*.js'),
  ];
}

export async function measureMountedRows(treeRoot: string, count: number): Promise<AbProbeMetric> {
  const statePath = join(treeRoot, 'src/components/conversationListState.ts');
  if (!existsSync(statePath)) {
    return metric(
      'feed.mountedRowsAt10k',
      count,
      'rows',
      'no virtualizer on this tree; mounted rows equal retained rows by construction',
    );
  }
  const state = (await import(pathToFileURL(statePath).href)) as ConversationListStateModule;
  const mounted = mountedWindow(state, count);
  return metric(
    'feed.mountedRowsAt10k',
    mounted,
    'rows',
    'tanstack Virtualizer with this tree’s conversationListState constants',
  );
}

async function measureFeedProjection(treeRoot: string): Promise<AbProbeMetric[]> {
  const chatPath = join(treeRoot, 'src/components/chat.tsx');
  if (!existsSync(chatPath)) {
    return [
      metric('feed.projectionMsPerDelta', NaN, 'ms', 'chat.tsx missing'),
      metric('feed.eventsRebuiltPerDelta', NaN, 'events', 'chat.tsx missing'),
      metric('feed.rowVisitsPerTailDeltaAt10k', NaN, 'rows', 'chat.tsx missing'),
    ];
  }
  const chat = (await import(pathToFileURL(chatPath).href)) as ChatModule;
  const projectorPath = join(treeRoot, 'src/components/chatFeedProjector.ts');
  const mutationPath = join(treeRoot, 'src/lib/transcriptMutation.ts');
  const events: ReturnType<typeof textEvent>[] = [];
  const settledTurns = Math.floor(STREAM_PREFIX_EVENTS / 2);
  for (let turn = 0; turn < settledTurns; turn += 1) {
    events.push(textEvent(`user-${String(turn)}`, turn * 2, 'user'));
    events.push(textEvent(`answer-${String(turn)}`, turn * 2 + 1, 'assistant'));
  }
  events.push(textEvent('user-live', settledTurns * 2, 'user'));
  const durations: number[] = [];
  const rebuilt: number[] = [];
  if (existsSync(projectorPath) && existsSync(mutationPath)) {
    const projectorMod = (await import(pathToFileURL(projectorPath).href)) as ProjectorModule;
    const mutationMod = (await import(pathToFileURL(mutationPath).href)) as MutationModule;
    const project = projectorMod.createChatFeedProjector();
    let transcript = [...events, textEvent('assistant-live', events.length, 'assistant')];
    let mutation: unknown;
    project({
      conversationKey: 'probe:primary',
      allTranscript: transcript,
      transcriptMutation: undefined,
      childSessionId: null,
      pending: true,
      options: { childSessionCards: true, changes: true, groupChildSessions: true },
    });
    for (let delta = 0; delta < STREAM_DELTAS; delta += 1) {
      const last = transcript.at(-1);
      if (!last) throw new Error('streaming transcript missing tail event');
      const next = [
        ...transcript.slice(0, -1),
        { ...last, text: `${last.text} token${String(delta)}`, ts: last.ts + 1 },
      ];
      mutation = mutationMod.nextTranscriptMutation(mutation, {
        kind: 'append',
        previousLength: transcript.length,
        firstChangedIndex: transcript.length - 1,
      });
      const started = performance.now();
      const projection = project({
        conversationKey: 'probe:primary',
        allTranscript: next,
        transcriptMutation: mutation,
        childSessionId: null,
        pending: true,
        options: { childSessionCards: true, changes: true, groupChildSessions: true },
      });
      durations.push(performance.now() - started);
      rebuilt.push(projection.feedItems.length - projection.rebuiltFromFeedItemIndex);
      transcript = next;
    }
  } else {
    let transcript = [...events, textEvent('assistant-live', events.length, 'assistant')];
    for (let delta = 0; delta < STREAM_DELTAS; delta += 1) {
      const last = transcript.at(-1);
      if (!last) throw new Error('streaming transcript missing tail event');
      transcript = [
        ...transcript.slice(0, -1),
        { ...last, text: `${last.text} token${String(delta)}`, ts: last.ts + 1 },
      ];
      const started = performance.now();
      const feed = chat.buildGroupedFeed(transcript, true, {
        childSessionCards: true,
        changes: true,
        groupChildSessions: true,
      });
      durations.push(performance.now() - started);
      rebuilt.push(feed.length);
    }
  }
  const mounted = await measureMountedRows(treeRoot, HISTORY_10K);
  return [
    metric(
      'feed.projectionMsPerDelta',
      median(durations),
      'ms',
      existsSync(projectorPath)
        ? 'createChatFeedProjector incremental tail appends'
        : 'buildGroupedFeed full rebuild per delta',
    ),
    metric(
      'feed.eventsRebuiltPerDelta',
      median(rebuilt),
      'events',
      existsSync(projectorPath)
        ? 'feed items from rebuiltFromFeedItemIndex to end after an incremental tail append'
        : 'full grouped-feed item count per rebuild',
    ),
    metric(
      'feed.rowVisitsPerTailDeltaAt10k',
      mounted.value,
      'rows',
      'rows participating in a tail update equal the mounted window on this tree',
    ),
  ];
}

async function measureMarkdown(treeRoot: string): Promise<AbProbeMetric> {
  const markdownPath = join(treeRoot, 'src/components/Markdown.tsx');
  if (!existsSync(markdownPath)) {
    return metric('markdown.perDeltaRenderMs', NaN, 'ms', 'Markdown.tsx missing');
  }
  const mod = (await import(pathToFileURL(markdownPath).href)) as { Markdown: MarkdownComponent };
  const Markdown = mod.Markdown;
  let text = '# stream\n\n';
  const durations: number[] = [];
  for (let delta = 0; delta < STREAM_DELTAS; delta += 1) {
    text += `token${String(delta)} `;
    const started = performance.now();
    renderToStaticMarkup(
      createElement(Markdown as ComponentType<{ children: string }>, { children: text }),
    );
    durations.push(performance.now() - started);
  }
  return metric(
    'markdown.perDeltaRenderMs',
    median(durations),
    'ms',
    'renderToStaticMarkup of this tree’s Markdown on a growing stream',
  );
}

async function measureTerminalFlood(treeRoot: string): Promise<AbProbeMetric> {
  const terminalPath = join(treeRoot, 'electron/terminal.cjs');
  if (!existsSync(terminalPath)) {
    return metric('terminal.deliveriesPerFlood', NaN, 'messages', 'electron/terminal.cjs missing');
  }
  const requireFromTree = createRequire(terminalPath);
  const terminal = requireFromTree(terminalPath) as TerminalModule;
  const portPath = join(dirname(terminalPath), 'terminalPort.cjs');
  const registryMod = existsSync(portPath)
    ? (requireFromTree(portPath) as RegistryModule)
    : terminal.createTerminalSubscriptionRegistry
      ? terminal
      : null;
  if (!registryMod?.createTerminalSubscriptionRegistry) {
    return metric(
      'terminal.deliveriesPerFlood',
      NaN,
      'messages',
      'no subscription registry on this tree',
    );
  }
  const { manager, instances } = createTerminalFixture(terminal);
  const terminalId = (await manager.create({ appSessionId: 'session-1', cwd: '/tmp' })).id;
  const timers: Array<{ callback: () => void }> = [];
  const registry = registryMod.createTerminalSubscriptionRegistry(manager, {
    setTimeout: (callback: () => void) => {
      const handle = { callback };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle: { callback: () => void }) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const sender = fakeSender();
  const port = fakePort();
  try {
    registry.subscribe(sender, terminalId, port);
  } catch {
    registry.subscribe(sender, terminalId);
  }
  for (let index = 0; index < TERMINAL_FLOOD_CHUNKS; index += 1) {
    instances[0]?.emitData(TERMINAL_CHUNK);
  }
  for (const timer of timers.splice(0)) timer.callback();
  const dataDeliveries = port.posted.filter((payload) => payload?.kind === 'data').length;
  const ipcDeliveries = sender.sends.filter((send) => send.payload?.kind === 'data').length;
  const deliveries = dataDeliveries + ipcDeliveries;
  manager.kill(terminalId);
  return metric(
    'terminal.deliveriesPerFlood',
    deliveries,
    'messages',
    existsSync(portPath)
      ? 'MessagePort data posts after a 1000-chunk flood'
      : 'ipc sender.send data events after a 1000-chunk flood',
  );
}

function mountedWindow(state: ConversationListStateModule, count: number): number {
  const viewportHeight = state.CONVERSATION_LIST_INITIAL_RECT.height;
  let scrollTop = state.estimatedListEndOffset(count, viewportHeight);
  const element = {
    clientHeight: viewportHeight,
    clientWidth: state.CONVERSATION_LIST_INITIAL_RECT.width,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
  } as HTMLDivElement;
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => element,
    estimateSize: () => state.CONVERSATION_LIST_ESTIMATE_PX,
    overscan: state.CONVERSATION_LIST_OVERSCAN,
    gap: state.CONVERSATION_LIST_GAP_PX,
    initialRect: { width: state.CONVERSATION_LIST_INITIAL_RECT.width, height: viewportHeight },
    initialOffset: scrollTop,
    observeElementRect: (_instance, cb) => {
      cb({ width: state.CONVERSATION_LIST_INITIAL_RECT.width, height: viewportHeight });
    },
    observeElementOffset: (_instance, cb) => {
      cb(scrollTop, false);
    },
    scrollToFn: (offset) => {
      scrollTop = offset;
    },
  });
  virtualizer._willUpdate();
  return virtualizer.getVirtualItems().length;
}

function createTerminalFixture(terminal: TerminalModule) {
  const instances: Array<{ emitData: (data: string) => void }> = [];
  const manager = terminal.createTerminalManager({
    platform: 'darwin',
    randomId: (() => {
      let id = 0;
      return () => `probe-terminal-${String(++id)}`;
    })(),
    fsp: {
      stat: async () => ({ isDirectory: () => true }),
      realpath: async (cwd: string) => cwd,
    },
    resolveShell: () => ({ file: '/bin/sh', args: [] }),
    buildEnv: () => ({ TERM: 'xterm-256color' }),
    loadPty: () => ({
      spawn() {
        let dataHandler: (data: string) => void = () => undefined;
        const instance = {
          writes: [],
          onData(handler: (data: string) => void) {
            dataHandler = handler;
          },
          onExit() {},
          write() {},
          resize() {},
          kill() {},
          emitData(data: string) {
            dataHandler(data);
          },
        };
        instances.push(instance);
        return instance;
      },
    }),
  });
  return { manager, instances };
}

function fakeSender() {
  const sender = new EventEmitter() as EventEmitter & {
    id: number;
    destroyed: boolean;
    isDestroyed: () => boolean;
    send: (channel: string, payload: { kind?: string }) => void;
    sends: Array<{ channel: string; payload: { kind?: string } }>;
  };
  sender.id = 1;
  sender.destroyed = false;
  sender.isDestroyed = () => sender.destroyed;
  sender.sends = [];
  sender.send = (channel, payload) => {
    sender.sends.push({ channel, payload });
  };
  return sender;
}

function fakePort() {
  const posted: Array<{ kind?: string }> = [];
  return {
    posted,
    closed: false,
    start() {},
    postMessage(data: { kind?: string }) {
      posted.push(data);
    },
    close() {
      this.closed = true;
    },
    on() {},
    removeListener() {},
  };
}

function textEvent(id: string, ts: number, author: 'user' | 'assistant' = 'assistant') {
  return {
    id,
    appSessionId: 'probe',
    sourceSessionId: author === 'user' ? 'user' : 'primary',
    role: 'primary' as const,
    kind: 'text' as const,
    author,
    text: id,
    ts,
  };
}

function metric(id: string, value: number, unit: string, method: string): AbProbeMetric {
  return { id, value, unit, method };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? NaN;
}

interface ConversationListStateModule {
  CONVERSATION_LIST_OVERSCAN: number;
  CONVERSATION_LIST_ESTIMATE_PX: number;
  CONVERSATION_LIST_GAP_PX: number;
  CONVERSATION_LIST_INITIAL_RECT: { width: number; height: number };
  estimatedListEndOffset: (count: number, viewportHeight?: number) => number;
}

interface ChatModule {
  buildGroupedFeed: (
    events: ReturnType<typeof textEvent>[],
    pending: boolean,
    options?: { childSessionCards?: boolean; changes?: boolean; groupChildSessions?: boolean },
  ) => unknown[];
}

interface ProjectorModule {
  createChatFeedProjector: () => (input: {
    conversationKey: string;
    allTranscript: ReturnType<typeof textEvent>[];
    transcriptMutation: unknown;
    childSessionId: string | null;
    pending: boolean;
    options: { childSessionCards: boolean; changes: boolean; groupChildSessions: boolean };
  }) => {
    visibleTranscript: unknown[];
    reusedVisibleEventCount: number;
    feedItems: unknown[];
    rebuiltFromFeedItemIndex: number;
  };
}

interface MutationModule {
  nextTranscriptMutation: (previous: unknown, change: unknown) => unknown;
}

type MarkdownComponent = ComponentType<{ children: string }>;

interface TerminalModule {
  createTerminalManager: (options: unknown) => {
    create: (options: { appSessionId: string; cwd: string }) => Promise<{ id: string }>;
    kill: (id: string) => void;
  };
  createTerminalSubscriptionRegistry?: RegistryModule['createTerminalSubscriptionRegistry'];
}

interface RegistryModule {
  createTerminalSubscriptionRegistry: (
    manager: unknown,
    options?: unknown,
  ) => {
    subscribe: (sender: unknown, terminalId: string, port?: unknown) => void;
  };
}
