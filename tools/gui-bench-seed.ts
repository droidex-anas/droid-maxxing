import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUI_BENCH_SESSION_IDS = {
  chat3k: 'gui-bench-3k',
  chat10k: 'gui-bench-10k',
  chatChildren: 'gui-bench-children',
  chatHeavy: 'gui-bench-heavy',
} as const;

export interface SeededSession {
  id: string;
  title: string;
  targetEvents: number;
  eventCount: number;
  lineCount: number;
  childCount: number;
  path: string;
}

export interface SeedManifest {
  home: string;
  sessionsDir: string;
  sessions: SeededSession[];
}

const TITLES: Record<string, string> = {
  [GUI_BENCH_SESSION_IDS.chat3k]: 'GUI bench 3k',
  [GUI_BENCH_SESSION_IDS.chat10k]: 'GUI bench 10k',
  [GUI_BENCH_SESSION_IDS.chatChildren]: 'GUI bench children',
  [GUI_BENCH_SESSION_IDS.chatHeavy]: 'GUI bench heavy',
};

const LABELS = ['explore', 'implement', 'review', 'test', 'docs', 'types', 'lint', 'perf'];

export function seedGuiBenchHistory(home: string): SeedManifest {
  const sessionsDir = join(home, '.factory', 'sessions', '2026', '08');
  mkdirSync(sessionsDir, { recursive: true });
  const sessions = [
    writeChat(sessionsDir, GUI_BENCH_SESSION_IDS.chat3k, 3_000, 4),
    writeChat(sessionsDir, GUI_BENCH_SESSION_IDS.chat10k, 10_000, 8),
    writeChildrenChat(sessionsDir, GUI_BENCH_SESSION_IDS.chatChildren, 24),
    writeHeavyChat(sessionsDir, GUI_BENCH_SESSION_IDS.chatHeavy),
  ];
  return { home, sessionsDir, sessions };
}

function writeChat(
  sessionsDir: string,
  id: string,
  targetEvents: number,
  childSpawns: number,
): SeededSession {
  const random = mulberry32(hashId(id));
  const lines: string[] = [sessionStart(id, TITLES[id] ?? id)];
  let events = 0;
  let turn = 0;
  let childCount = 0;
  while (events < targetEvents) {
    const remaining = targetEvents - events;
    const kind = pickKind(random, remaining, childCount < childSpawns);
    const built = buildTurn(id, turn, kind, random);
    lines.push(...built.lines);
    events += built.events;
    childCount += built.children;
    turn += 1;
  }
  const path = join(sessionsDir, `${id}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return {
    id,
    title: TITLES[id] ?? id,
    targetEvents,
    eventCount: events,
    lineCount: lines.length,
    childCount,
    path,
  };
}

function writeChildrenChat(sessionsDir: string, id: string, childCount: number): SeededSession {
  const random = mulberry32(hashId(id));
  const lines: string[] = [sessionStart(id, TITLES[id] ?? id)];
  let events = 0;
  lines.push(userLine(id, 0, 'Spin up a wave of subagents and keep them busy.'));
  events += 1;
  const waveSize = 8;
  const waves = Math.ceil(childCount / waveSize);
  for (let wave = 0; wave < waves; wave += 1) {
    const start = wave * waveSize;
    const count = Math.min(waveSize, childCount - start);
    const built = childWave(id, wave, start, count, random);
    lines.push(...built.lines);
    events += built.events;
    for (let index = 0; index < count; index += 1) {
      const childId = `${id}-child-${String(start + index)}`;
      const childPath = join(sessionsDir, `${childId}.jsonl`);
      writeFileSync(childPath, childTranscript(id, childId, start + index, random));
    }
  }
  lines.push(
    assistantTextLine(
      id,
      900,
      'All worker waves reported back. The parent summary stays short so the dock cards remain the expensive rows.',
    ),
  );
  events += 1;
  const path = join(sessionsDir, `${id}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return {
    id,
    title: TITLES[id] ?? id,
    targetEvents: events,
    eventCount: events,
    lineCount: lines.length,
    childCount,
    path,
  };
}

function writeHeavyChat(sessionsDir: string, id: string): SeededSession {
  const lines: string[] = [sessionStart(id, TITLES[id] ?? id)];
  const turns: Array<{ user: string; assistant: string }> = [
    { user: 'Show a large TypeScript fixture.', assistant: heavyCodeAnswer() },
    { user: 'Tabulate the inventory.', assistant: heavyTableAnswer() },
    { user: 'Write a longer explanation of the render path.', assistant: heavyProseAnswer() },
    { user: 'Draw the send path as a flowchart.', assistant: heavyMermaidAnswer() },
    { user: 'Render a dashboard of the last 400 rows.', assistant: heavyJsonAnswer() },
    { user: 'Show an in-chat app with KaTeX.', assistant: heavyAppAnswer() },
    { user: 'And another app beside it.', assistant: heavyAppAnswer(2) },
    { user: 'Patch the bench file.', assistant: 'Finished the ApplyPatch call.' },
  ];
  let events = 0;
  turns.forEach((turn, index) => {
    lines.push(userLine(id, index, turn.user));
    events += 1;
    if (index === turns.length - 1) {
      const toolUseId = `${id}-patch`;
      lines.push(toolCall(id, index, toolUseId, 'ApplyPatch', () => 0.5));
      lines.push(toolResult(id, index, toolUseId, 'ApplyPatch', heavyDiffOutput()));
      events += 2;
    }
    lines.push(assistantTextLine(id, index, turn.assistant));
    events += 1;
  });
  const path = join(sessionsDir, `${id}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return {
    id,
    title: TITLES[id] ?? id,
    targetEvents: events,
    eventCount: events,
    lineCount: lines.length,
    childCount: 0,
    path,
  };
}

function heavyCodeAnswer(): string {
  const rows = Array.from({ length: 360 }, (_, index) => `  row${String(index)}: ${String(index)},`);
  return [
    'Here is a generated fixture for the render bench:',
    '',
    '```ts',
    'export const fixture = {',
    ...rows,
    '};',
    '```',
    '',
    'Heights vary because the fence length varies.',
  ].join('\n');
}

function heavyTableAnswer(): string {
  const header = `| ${Array.from({ length: 10 }, (_, index) => `Col ${String(index)}`).join(' | ')} |`;
  const align = `| ${Array.from({ length: 10 }, () => '---').join(' | ')} |`;
  const rows = Array.from({ length: 36 }, (_, row) => {
    return `| ${Array.from({ length: 10 }, (_, col) => `r${String(row)}c${String(col)}`).join(' | ')} |`;
  });
  return ['## Inventory', '', header, align, ...rows].join('\n');
}

function heavyProseAnswer(): string {
  const paragraph =
    'Paragraph of the render path walks through recovery, scroll restoration, and why a bounded mounted window must still cover a flick. ';
  return `### Long answer\n\n${paragraph.repeat(80)}`;
}

function heavyMermaidAnswer(): string {
  return [
    'The send path as a flowchart:',
    '',
    '```mermaid',
    'flowchart TD',
    '  K[Keystroke] --> C[Composer]',
    '  C --> E[Enter]',
    '  E --> O[Optimistic echo]',
    '  O --> G[Git baseline]',
    '  G --> S[session.send]',
    '  S --> P[Provider stream]',
    '  P --> M[Markdown]',
    '  M --> V[Visualization]',
    '```',
  ].join('\n');
}

function heavyJsonAnswer(): string {
  const elements: Record<string, unknown> = {
    root: { type: 'Box', props: { flexDirection: 'column', gap: 1 }, children: [] as string[] },
  };
  const children: string[] = [];
  for (let index = 0; index < 220; index += 1) {
    const id = `n${String(index)}`;
    children.push(id);
    elements[id] = { type: 'Text', props: { text: `Row ${String(index)}` } };
  }
  (elements.root as { children: string[] }).children = children;
  return `<json-render>${JSON.stringify({ root: 'root', elements })}</json-render>`;
}

function heavyAppAnswer(variant = 1): string {
  const latex = variant === 1 ? 'E = mc^2' : '\\int_0^1 x^2\\,dx = \\tfrac{1}{3}';
  return [
    '```app',
    '<!doctype html><html><body>',
    `<main><h1>App ${String(variant)}</h1><div data-latex="${latex}"></div></main>`,
    '<script>',
    'window.droidex?.renderAllMath?.();',
    'window.parent.postMessage({type:"droidex:app-ready",instanceId:window.__DROIDEX_INSTANCE_ID},"*");',
    '</script>',
    '</body></html>',
    '```',
  ].join('\n');
}

function heavyDiffOutput(): string {
  const lines = [
    '*** Update File: src/bench/turn-heavy.ts',
    '@@ -1,3 +1,80 @@',
    '-const value = 1;',
  ];
  for (let index = 0; index < 120; index += 1) {
    lines.push(`+const value_${String(index)} = ${String(index)};`);
  }
  return lines.join('\n');
}

type TurnKind =
  | 'short'
  | 'markdown'
  | 'long'
  | 'code'
  | 'tools'
  | 'task'
  | 'thinking'
  | 'compaction';

function pickKind(random: () => number, remaining: number, allowTask: boolean): TurnKind {
  if (remaining <= 2) return 'short';
  const roll = random();
  if (allowTask && roll < 0.04) return 'task';
  if (roll < 0.18) return 'short';
  if (roll < 0.4) return 'markdown';
  if (roll < 0.52) return 'long';
  if (roll < 0.68) return 'code';
  if (roll < 0.86) return 'tools';
  if (roll < 0.94) return 'thinking';
  return 'compaction';
}

function buildTurn(
  sessionId: string,
  turn: number,
  kind: TurnKind,
  random: () => number,
): { lines: string[]; events: number; children: number } {
  const user = userLine(sessionId, turn, userPrompt(kind, turn, random));
  if (kind === 'short') {
    return {
      lines: [user, assistantTextLine(sessionId, turn, shortAnswer(turn, random))],
      events: 2,
      children: 0,
    };
  }
  if (kind === 'markdown') {
    return {
      lines: [user, assistantTextLine(sessionId, turn, markdownAnswer(turn, random))],
      events: 2,
      children: 0,
    };
  }
  if (kind === 'long') {
    return {
      lines: [user, assistantTextLine(sessionId, turn, longAnswer(turn, random))],
      events: 2,
      children: 0,
    };
  }
  if (kind === 'code') {
    return {
      lines: [user, assistantTextLine(sessionId, turn, codeAnswer(turn, random))],
      events: 2,
      children: 0,
    };
  }
  if (kind === 'thinking') {
    return {
      lines: [user, thinkingAndText(sessionId, turn, random)],
      events: 2,
      children: 0,
    };
  }
  if (kind === 'compaction') {
    return {
      lines: [user, assistantTextLine(sessionId, turn, shortAnswer(turn, random)), compactionLine(turn)],
      events: 3,
      children: 0,
    };
  }
  if (kind === 'task') {
    const toolUseId = `${sessionId}-task-${String(turn)}`;
    return {
      lines: [
        user,
        taskCall(sessionId, turn, toolUseId, random),
        toolResult(sessionId, turn, toolUseId, 'Task', `Worker ${String(turn)} completed.`),
        assistantTextLine(sessionId, turn, `Delegated turn ${String(turn)} to a worker.`),
      ],
      events: 4,
      children: 1,
    };
  }
  const toolUseId = `${sessionId}-tool-${String(turn)}`;
  const tool = random() < 0.5 ? 'Read' : 'ApplyPatch';
  return {
    lines: [
      user,
      toolCall(sessionId, turn, toolUseId, tool, random),
      toolResult(sessionId, turn, toolUseId, tool, toolOutput(tool, turn, random)),
      assistantTextLine(sessionId, turn, `Finished the ${tool} call for turn ${String(turn)}.`),
    ],
    events: 4,
    children: 0,
  };
}

function childWave(
  sessionId: string,
  wave: number,
  start: number,
  count: number,
  random: () => number,
): { lines: string[]; events: number } {
  const lines: string[] = [];
  let events = 0;
  for (let index = 0; index < count; index += 1) {
    const childIndex = start + index;
    const toolUseId = `${sessionId}-spawn-${String(childIndex)}`;
    lines.push(taskCall(sessionId, 1000 + childIndex, toolUseId, random, childIndex));
    events += 1;
  }
  for (let index = 0; index < count; index += 1) {
    const childIndex = start + index;
    const toolUseId = `${sessionId}-spawn-${String(childIndex)}`;
    lines.push(
      toolResult(
        sessionId,
        2000 + childIndex,
        toolUseId,
        'Task',
        `Wave ${String(wave)} worker ${String(childIndex)} settled.`,
      ),
    );
    events += 1;
  }
  return { lines, events };
}

function childTranscript(
  parentId: string,
  childId: string,
  index: number,
  random: () => number,
): string {
  const label = LABELS[index % LABELS.length] ?? 'worker';
  const lines = [
    JSON.stringify({
      type: 'session_start',
      id: childId,
      cwd: '',
      sessionTitle: `${label} ${String(index)}`,
      settings: { interactionMode: 'auto' },
      callingSessionId: parentId,
      callingToolUseId: `${parentId}-spawn-${String(index)}`,
    }),
    userLine(childId, 0, `Work on ${label} slice ${String(index)}.`),
    assistantTextLine(childId, 1, markdownAnswer(index, random)),
    toolCall(childId, 2, `${childId}-read`, 'Read', random),
    toolResult(childId, 3, `${childId}-read`, 'Read', toolOutput('Read', index, random)),
    assistantTextLine(childId, 4, `Child ${String(index)} finished ${label}.`),
  ];
  return `${lines.join('\n')}\n`;
}

function sessionStart(id: string, title: string): string {
  return JSON.stringify({
    type: 'session_start',
    id,
    cwd: '',
    sessionTitle: title,
    title,
    settings: { interactionMode: 'auto', modelId: 'model-default' },
  });
}

function userLine(sessionId: string, turn: number, text: string): string {
  return JSON.stringify({
    type: 'message',
    id: `${sessionId}-u-${String(turn)}`,
    timestamp: iso(turn * 4),
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function assistantTextLine(sessionId: string, turn: number, text: string): string {
  return JSON.stringify({
    type: 'message',
    id: `${sessionId}-a-${String(turn)}`,
    timestamp: iso(turn * 4 + 1),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function thinkingAndText(sessionId: string, turn: number, random: () => number): string {
  return JSON.stringify({
    type: 'message',
    id: `${sessionId}-a-${String(turn)}`,
    timestamp: iso(turn * 4 + 1),
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `Considering turn ${String(turn)} and the nearby files.` },
        { type: 'text', text: shortAnswer(turn, random) },
      ],
    },
  });
}

function toolCall(
  sessionId: string,
  turn: number,
  toolUseId: string,
  name: string,
  random: () => number,
): string {
  const input =
    name === 'ApplyPatch'
      ? {
          path: `src/bench/turn-${String(turn)}.ts`,
          old: 'const value = 1;',
          new: `const value = ${String(Math.floor(random() * 9) + 2)};`,
        }
      : { path: `src/bench/turn-${String(turn)}.ts` };
  return JSON.stringify({
    type: 'message',
    id: `${sessionId}-a-${String(turn)}`,
    timestamp: iso(turn * 4 + 1),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input }],
    },
  });
}

function taskCall(
  sessionId: string,
  turn: number,
  toolUseId: string,
  random: () => number,
  childIndex = turn,
): string {
  const label = LABELS[childIndex % LABELS.length] ?? 'worker';
  return JSON.stringify({
    type: 'message',
    id: `${sessionId}-a-${String(turn)}`,
    timestamp: iso(turn * 4 + 1),
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Task',
          input: {
            subagent_type: label,
            description: `${label} wave item ${String(childIndex)}`,
            prompt: `Investigate ${label} for item ${String(childIndex)}. seed=${random().toFixed(4)}`,
          },
        },
      ],
    },
  });
}

function toolResult(
  sessionId: string,
  turn: number,
  toolUseId: string,
  name: string,
  text: string,
): string {
  return JSON.stringify({
    type: 'message',
    id: `${sessionId}-r-${String(turn)}`,
    timestamp: iso(turn * 4 + 2),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, name, content: text }],
    },
  });
}

function compactionLine(turn: number): string {
  return JSON.stringify({
    type: 'compaction_state',
    id: `compaction-${String(turn)}`,
    timestamp: iso(turn * 4 + 3),
    removedCount: 12,
  });
}

function userPrompt(kind: TurnKind, turn: number, random: () => number): string {
  if (kind === 'code') return `Show a ${pick(random, ['TypeScript', 'SQL', 'Rust'])} snippet for turn ${String(turn)}.`;
  if (kind === 'tools') return `Inspect the files around turn ${String(turn)}.`;
  if (kind === 'task') return `Delegate the ${pick(random, LABELS)} work for turn ${String(turn)}.`;
  if (kind === 'long') return `Write a longer explanation of the ${pick(random, LABELS)} path.`;
  return `Continue with step ${String(turn)}.`;
}

function shortAnswer(turn: number, random: () => number): string {
  return `Turn ${String(turn)} is a short reply about ${pick(random, LABELS)}.`;
}

function markdownAnswer(turn: number, random: () => number): string {
  const topic = pick(random, LABELS);
  return [
    `## Turn ${String(turn)}: ${topic}`,
    '',
    `The ${topic} path needs a measured change, not a rewrite.`,
    '',
    `- Keep the owner of ${topic} state in one module`,
    `- Fail visibly when ${topic} invariants break`,
    `- Do not add a second cache`,
    '',
    `See \`src/${topic}/handler.ts\` for the current entry.`,
  ].join('\n');
}

function longAnswer(turn: number, random: () => number): string {
  const paragraphs = Array.from({ length: 4 + Math.floor(random() * 4) }, (_, index) => {
    return `Paragraph ${String(index + 1)} of turn ${String(turn)} walks through recovery, scroll restoration, and why a bounded mounted window must still cover a flick. ${pick(random, LABELS)} stays the example.`;
  });
  return [`### Long answer ${String(turn)}`, '', ...paragraphs].join('\n');
}

function codeAnswer(turn: number, random: () => number): string {
  const lines = Array.from({ length: 12 + Math.floor(random() * 40) }, (_, index) => {
    return `  row${String(index)}: ${String(turn + index)},`;
  });
  return [
    `Here is a generated fixture for turn ${String(turn)}:`,
    '',
    '```ts',
    'export const fixture = {',
    ...lines,
    '};',
    '```',
    '',
    'Heights vary because the fence length varies.',
  ].join('\n');
}

function toolOutput(tool: string, turn: number, random: () => number): string {
  if (tool === 'ApplyPatch') {
    return [
      `*** Update File: src/bench/turn-${String(turn)}.ts`,
      '@@ -1,3 +1,6 @@',
      '-const value = 1;',
      `+const value = ${String(Math.floor(random() * 9) + 2)};`,
      '+export function read() {',
      '+  return value;',
      '+}',
    ].join('\n');
  }
  return `contents of src/bench/turn-${String(turn)}.ts\nexport const n = ${String(turn)};\n`;
}

function iso(step: number): string {
  return new Date(Date.UTC(2026, 7, 1, 12, 0, 0, step * 250)).toISOString();
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick() received an empty list.');
  return item;
}

function hashId(id: string): number {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv: string[]): { home: string } {
  let home = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--home') {
      home = requiredValue(argv, ++index, arg);
    }
  }
  if (!home) throw new Error('gui-bench-seed requires --home <dir>.');
  return { home };
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === entry;
}

if (isDirectRun()) {
  const { home } = parseArgs(process.argv.slice(2));
  const manifest = seedGuiBenchHistory(home);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
