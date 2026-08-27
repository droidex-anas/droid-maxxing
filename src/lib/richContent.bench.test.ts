import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { JsonRender } from '../components/JsonRender';
import { Markdown } from '../components/Markdown';
import { MessageBody } from '../components/MessageBody';
import { composePrompt } from './composePrompt';
import { parseUnifiedDiff } from './unifiedDiff';

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted[mid];
  return value ?? 0;
}

function measure(fn: () => void, rounds = 9): { medianMs: number; minMs: number; maxMs: number } {
  fn();
  const samples: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return { medianMs: median(samples), minMs: Math.min(...samples), maxMs: Math.max(...samples) };
}

function largeCodeFence(): string {
  const lines = Array.from(
    { length: 400 },
    (_, index) => `  row${String(index)}: ${String(index)},`,
  );
  return [
    'Here is a generated fixture:',
    '',
    '```ts',
    'export const fixture = {',
    ...lines,
    '};',
    '```',
  ].join('\n');
}

function wideTable(): string {
  const header = `| ${Array.from({ length: 12 }, (_, index) => `Col ${String(index)}`).join(' | ')} |`;
  const align = `| ${Array.from({ length: 12 }, () => '---').join(' | ')} |`;
  const rows = Array.from({ length: 40 }, (_, row) => {
    return `| ${Array.from({ length: 12 }, (_, col) => `r${String(row)}c${String(col)}`).join(' | ')} |`;
  });
  return ['## Inventory', '', header, align, ...rows].join('\n');
}

function longProse(): string {
  const paragraph =
    'The bounded mounted window still has to cover a flick, so first-render cost of settled rich content matters more than per-token streaming work. ';
  return `### Long answer\n\n${paragraph.repeat(220)}`;
}

function mermaidFence(): string {
  return [
    '```mermaid',
    'flowchart TD',
    '  A[Send] --> B{Git baseline}',
    '  B --> C[Echo]',
    '  C --> D[Provider]',
    '  D --> E[Stream]',
    '  E --> F[Settled markdown]',
    '```',
  ].join('\n');
}

function appBlockFence(): string {
  return [
    '```app',
    '<!doctype html><html><body>',
    '<main><h1>Interactive App</h1><p>Hello from an in-chat app.</p></main>',
    '<script>window.parent.postMessage({type:"droidex:app-ready",instanceId:window.__DROIDEX_INSTANCE_ID},"*")</script>',
    '</body></html>',
    '```',
  ].join('\n');
}

function largeJsonSpec(): string {
  const elements: Record<string, unknown> = {
    root: { type: 'Box', props: { flexDirection: 'column', gap: 1 }, children: [] as string[] },
  };
  const children: string[] = [];
  for (let index = 0; index < 400; index += 1) {
    const id = `n${String(index)}`;
    children.push(id);
    elements[id] = {
      type: 'Text',
      props: { text: `Row ${String(index)} value=${String(index * 3)}` },
    };
  }
  (elements.root as { children: string[] }).children = children;
  return JSON.stringify({ root: 'root', elements });
}

function largeDiff(): string {
  const lines = [
    'diff --git a/src/bench.ts b/src/bench.ts',
    '--- a/src/bench.ts',
    '+++ b/src/bench.ts',
  ];
  for (let hunk = 0; hunk < 20; hunk += 1) {
    const start = hunk * 80 + 1;
    lines.push(`@@ -${String(start)},80 +${String(start)},80 @@`);
    for (let row = 0; row < 80; row += 1) {
      const kind = row % 5 === 0 ? '+' : row % 5 === 1 ? '-' : ' ';
      lines.push(`${kind}const value_${String(hunk)}_${String(row)} = ${String(row)};`);
    }
  }
  return lines.join('\n');
}

test('first-render cost of settled rich content stays in a snappy band', () => {
  const loadavg = readFileSync('/proc/loadavg', 'utf8').trim();
  const mixed = [longProse(), wideTable(), largeCodeFence(), mermaidFence(), appBlockFence()].join(
    '\n\n',
  );
  const jsonSource = largeJsonSpec();
  const diff = largeDiff();
  const paste = 'x'.repeat(100_000);

  const rows = {
    loadavg,
    prose: measure(() => {
      renderToStaticMarkup(createElement(Markdown, null, longProse()));
    }),
    table: measure(() => {
      renderToStaticMarkup(createElement(Markdown, null, wideTable()));
    }),
    codeFence: measure(() => {
      renderToStaticMarkup(createElement(Markdown, null, largeCodeFence()));
    }),
    mermaidFenceParse: measure(() => {
      renderToStaticMarkup(createElement(Markdown, null, mermaidFence()));
    }),
    mixedMessage: measure(() => {
      renderToStaticMarkup(
        createElement(MessageBody, {
          text: mixed,
          live: false,
          autoPlayAppBlocks: false,
          cacheId: 'bench',
        }),
      );
    }),
    jsonRender: measure(() => {
      renderToStaticMarkup(createElement(JsonRender, { source: jsonSource }));
    }),
    jsonFence: measure(() => {
      renderToStaticMarkup(createElement(Markdown, null, `\`\`\`json\n${jsonSource}\n\`\`\``));
    }),
    diffParse: measure(() => {
      parseUnifiedDiff(diff);
    }),
    compose100kb: measure(() => {
      composePrompt(paste, [], []);
    }),
    stringifySend100kb: measure(() => {
      JSON.stringify({ type: 'session.send', appSessionId: 's', text: paste });
    }),
  };

  console.info('rich-content first render', JSON.stringify(rows, null, 2));

  // These are guards against a silent blow-up, not product budgets. GUI numbers
  // decide whether a deferral is justified; SSR markup is the CPU floor.
  assert.ok(rows.prose.medianMs < 80, `prose first render ${String(rows.prose.medianMs)}ms`);
  assert.ok(rows.table.medianMs < 80, `table first render ${String(rows.table.medianMs)}ms`);
  assert.ok(
    rows.codeFence.medianMs < 80,
    `code fence first render ${String(rows.codeFence.medianMs)}ms`,
  );
  assert.ok(
    rows.mixedMessage.medianMs < 150,
    `mixed first render ${String(rows.mixedMessage.medianMs)}ms`,
  );
  assert.ok(
    rows.jsonRender.medianMs < 80,
    `json-render first render ${String(rows.jsonRender.medianMs)}ms`,
  );
  assert.ok(
    rows.jsonFence.medianMs < 40,
    `json fence first render ${String(rows.jsonFence.medianMs)}ms`,
  );
  assert.ok(rows.diffParse.medianMs < 40, `diff parse ${String(rows.diffParse.medianMs)}ms`);
  assert.ok(
    rows.compose100kb.medianMs < 10,
    `compose 100kb ${String(rows.compose100kb.medianMs)}ms`,
  );
  assert.ok(
    rows.stringifySend100kb.medianMs < 20,
    `stringify 100kb ${String(rows.stringifySend100kb.medianMs)}ms`,
  );
});
