import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TranscriptEvent } from '../../types/bridge';
import { DiffCard } from '../DiffView';
import { PlanUpdate, ShellCard, ToolLine } from './cards';

let sequence = 0;

function event(extra: Partial<TranscriptEvent>): TranscriptEvent {
  sequence += 1;
  return {
    id: `card-${sequence}`,
    appSessionId: 'session',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'tool_call',
    ts: sequence,
    ...extra,
  };
}

test('shell rows stay collapsed and do not mount output by default', () => {
  const html = renderToStaticMarkup(
    createElement(ShellCard, {
      command: 'npm run typecheck',
      output: 'SECRET SHELL OUTPUT',
      running: false,
    }),
  );

  assert.match(html, />Ran</);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /SECRET SHELL OUTPUT/);
  assert.doesNotMatch(html, /droid-tool-panel/);
});

test('running shell rows use the live shell label without mounting output', () => {
  const html = renderToStaticMarkup(
    createElement(ShellCard, {
      command: 'git status --short',
      output: 'SECRET LIVE OUTPUT',
      running: true,
    }),
  );

  assert.match(html, />Running</);
  assert.match(html, /shimmer-text/);
  assert.doesNotMatch(html, /SECRET LIVE OUTPUT/);
});

test('read and search rows keep their captured body behind their own disclosure', () => {
  const html = renderToStaticMarkup(
    createElement(ToolLine, {
      event: event({
        toolName: 'Read',
        toolArgs: { file_path: 'src/components/chat.tsx' },
      }),
      output: 'SECRET FILE BODY',
    }),
  );

  assert.match(html, />Read</);
  assert.match(html, /chat\.tsx/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /SECRET FILE BODY/);
});

test('search rows render an icon-free pattern in the UI font', () => {
  const html = renderToStaticMarkup(
    createElement(ToolLine, {
      event: event({
        toolName: 'Grep',
        toolArgs: { pattern: 'feedRowId' },
      }),
    }),
  );

  assert.match(html, />Search</);
  assert.match(html, /feedRowId/);
  assert.match(html, /text-droid-text-secondary/);
  assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(html, /font-mono/);
});

test('plan updates collapse to a compact Updated plan row', () => {
  const html = renderToStaticMarkup(
    createElement(PlanUpdate, {
      event: event({
        toolName: 'TodoWrite',
        toolArgs: {
          todos:
            '1. [completed] Inspect the feed\n2. [in_progress] Restyle the plan\n3. [pending] Verify the rows',
        },
      }),
    }),
  );

  assert.match(html, />Updated</);
  assert.match(html, />plan</);
  assert.match(html, /text-droid-text-secondary/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Inspect the feed/);
  assert.doesNotMatch(html, /Restyle the plan/);
  assert.doesNotMatch(html, /Verify the rows/);
  assert.doesNotMatch(html, /font-mono/);
  assert.doesNotMatch(html, /line-through/);
});

test('live plan updates use Updating plan language without mounting steps', () => {
  const html = renderToStaticMarkup(
    createElement(PlanUpdate, {
      live: true,
      event: event({
        toolName: 'TodoWrite',
        toolArgs: {
          todos: '1. [in_progress] Restyle the plan\n2. [pending] Verify the rows',
        },
      }),
    }),
  );

  assert.match(html, />Updating</);
  assert.match(html, />plan</);
  assert.match(html, /shimmer-text/);
  assert.doesNotMatch(html, /Restyle the plan/);
});

test('an empty plan update is a static Updated plan row', () => {
  const html = renderToStaticMarkup(
    createElement(PlanUpdate, {
      event: event({
        toolName: 'TodoWrite',
        toolArgs: { todos: '' },
      }),
    }),
  );

  assert.match(html, />Updated</);
  assert.match(html, />plan</);
  assert.doesNotMatch(html, /aria-expanded/);
  assert.doesNotMatch(html, /font-mono/);
});

test('read rows render an icon-free compact path summary with read bounds', () => {
  const html = renderToStaticMarkup(
    createElement(ToolLine, {
      event: event({
        toolName: 'Read',
        toolArgs: {
          file_path: '/Users/anas/Documents/droid-control/src/lib/transcriptFeed.ts',
          offset: 0,
          limit: 290,
        },
      }),
      output: 'SECRET FILE BODY',
    }),
  );

  assert.match(html, /Read/);
  assert.match(html, /…\/src\/lib\/transcriptFeed\.ts, offset: 0, limit: 290/);
  assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(html, /SECRET FILE BODY/);
});

test('diff rows stay flat until opened and do not mount the preview by default', () => {
  const html = renderToStaticMarkup(
    createElement(DiffCard, {
      change: {
        path: 'src/example.ts',
        verb: 'edit',
        added: 1,
        removed: 1,
        ops: [
          { type: 'del', text: 'old value' },
          { type: 'add', text: 'new value' },
        ],
      },
    }),
  );

  assert.match(html, /src\/example\.ts/);
  assert.match(html, />Edit</);
  assert.match(html, /text-droid-text-secondary/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /old value/);
  assert.doesNotMatch(html, /new value/);
  assert.doesNotMatch(html, /droid-tool-panel/);
});

test('diff rows show a compact relative path while keeping the full path in the tooltip', () => {
  const fullPath = '/Users/anas/Documents/droid-control/src/components/example.ts';
  const html = renderToStaticMarkup(
    createElement(DiffCard, {
      cwd: '/Users/anas/Documents/droid-control',
      change: {
        path: fullPath,
        verb: 'patch',
        added: 1,
        removed: 0,
        ops: [{ type: 'add', text: 'new value' }],
      },
    }),
  );

  assert.match(html, /src\/components\/example\.ts/);
  assert.ok(html.includes(`title="${fullPath}"`));
});
