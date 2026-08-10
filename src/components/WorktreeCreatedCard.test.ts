import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorktreeCreatedCard } from './WorktreeCreatedCard';

test('worktree creation renders as an expanded, inspectable activity card', () => {
  const path = '/repo/.worktrees/f401/droid-control';
  const html = renderToStaticMarkup(createElement(WorktreeCreatedCard, { path }));

  assert.match(html, /Worktree created/);
  assert.match(html, /Preparing worktree \(detached HEAD\)/);
  assert.match(html, new RegExp(path.replaceAll('/', '\\/')));
  assert.match(html, /aria-expanded="true"/);
});
