import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandLine } from './commandCard';
import { LiveProcessesContext } from './liveProcessesContext';

test('a live descendant keeps its originating command expandable with captured output', () => {
  const render = (command: string) =>
    renderToStaticMarkup(
      createElement(
        LiveProcessesContext.Provider,
        {
          value: [
            {
              pid: 123,
              name: 'vite',
              command: 'node vite.js',
              originCommand: '/bin/zsh -c npm run dev',
              startedAt: 1,
              ports: [5173],
            },
          ],
        },
        createElement(CommandLine, { command, output: 'Server ready', forceOpen: true }),
      ),
    );
  const html = render('npm run dev');
  assert.match(html, /<button[^>]+aria-expanded="true"/);
  assert.match(html, />Running</);
  assert.match(html, /Server ready/);
  assert.doesNotMatch(render('npm run de'), />Running</);
});
