import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React, { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Virtualizer } from '@tanstack/virtual-core';

import { measureSidecarStartup } from './perfAbSidecarStartupProbe';
import { measureTerminalFlood } from './perfAbTerminalProbe';

export { TERMINAL_FLOOD_CHUNKS } from './perfAbTerminalProbe';

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
const STREAM_DELTAS = 40;
const STREAM_PREFIX_EVENTS = 200;

// Files loaded from another git worktree sit outside this package's
// tsconfig jsx setting; classic JSX in those graphs needs React in scope.
(globalThis as { React?: typeof React }).React = React;

export async function runAbProbes(treeRoot: string): Promise<AbProbeResult> {
  const notes: string[] = [];
  const metrics: AbProbeMetric[] = [];

  const bundle = measureBundle(treeRoot);
  if (bundle) metrics.push(...bundle);
  else notes.push('dist/ missing or unreadable; bundle metrics unmeasured.');

  await capture(notes, metrics, 'mounted rows', () => measureMountedRows(treeRoot, HISTORY_10K));
  await capture(notes, metrics, 'feed projection', async () => measureFeedProjection(treeRoot));
  await capture(notes, metrics, 'markdown', () => measureMarkdown(treeRoot));
  await capture(notes, metrics, 'terminal flood', () => measureTerminalFlood(treeRoot));
  await capture(notes, metrics, 'sidecar startup', () => measureSidecarStartup(treeRoot));

  return { treeRoot, metrics, notes };
}

async function capture(
  notes: string[],
  metrics: AbProbeMetric[],
  label: string,
  work: () => Promise<AbProbeMetric | AbProbeMetric[]>,
): Promise<void> {
  try {
    const result = await work();
    metrics.push(...(Array.isArray(result) ? result : [result]));
  } catch (error) {
    notes.push(`${label} unmeasured: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function measureBundle(treeRoot: string): AbProbeMetric[] | null {
  const distDir = join(treeRoot, 'dist');
  const assetsDir = join(distDir, 'assets');
  const htmlPath = join(distDir, 'index.html');
  if (!existsSync(htmlPath) || !existsSync(assetsDir)) return null;
  const html = readFileSync(htmlPath, 'utf8');
  const scriptSrcRe = /<script[^>]+src="\.\/assets\/([^"]+\.js)"/;
  const cssHrefRe = /<link[^>]+href="\.\/assets\/([^"]+\.css)"/;
  const scriptMatch = scriptSrcRe.exec(html);
  const cssMatch = cssHrefRe.exec(html);
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
  const turnsPath = join(treeRoot, 'src/components/chatFeedTurns.ts');
  if (!existsSync(chatPath) && !existsSync(turnsPath)) {
    return [
      metric('feed.projectionMsPerDelta', NaN, 'ms', 'chat.tsx missing'),
      metric('feed.eventsRebuiltPerDelta', NaN, 'events', 'chat.tsx missing'),
      metric('feed.rowVisitsPerTailDeltaAt10k', NaN, 'rows', 'chat.tsx missing'),
    ];
  }
  const groupedFeedPath = existsSync(turnsPath) ? turnsPath : chatPath;
  const chat = (await import(pathToFileURL(groupedFeedPath).href)) as ChatModule;
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
