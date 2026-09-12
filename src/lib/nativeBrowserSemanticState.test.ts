import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserElementRef, BrowserNativeSnapshot } from '../types/bridge';
import { buildBrowserSemanticState } from './nativeBrowserSemanticState';
import {
  BrowserSemanticStateTracker,
  diffBrowserSemanticStates,
} from './nativeBrowserSemanticTracker';

function ref(id: string, overrides: Partial<BrowserElementRef> = {}): BrowserElementRef {
  return {
    ref: id,
    selector: `[data-ref="${id}"]`,
    tagName: 'button',
    role: 'button',
    name: id,
    box: { x: 10, y: 20, width: 100, height: 32 },
    ...overrides,
  };
}

function snapshot(
  refs: BrowserElementRef[],
  overrides: Partial<BrowserNativeSnapshot> = {},
): BrowserNativeSnapshot {
  return {
    url: 'https://example.test/settings',
    title: 'Settings',
    scroll: { x: 0, y: 0 },
    canGoBack: false,
    canGoForward: false,
    refs,
    ...overrides,
  };
}

test('buildBrowserSemanticState separates visual capture from semantic actions', () => {
  const state = buildBrowserSemanticState(
    snapshot([
      ref('@save', {
        name: '  Save   changes  ',
        attributes: {
          class: 'primary button',
          type: 'submit',
          value: 'must-not-leak',
          'data-testid': 'save-settings',
        },
      }),
      ref('@password', {
        tagName: 'input',
        role: 'textbox',
        name: 'Password',
        text: 'must-not-leak-either',
        attributes: {
          type: 'password',
          name: 'password',
          autocomplete: 'current-password',
          value: 'hunter2',
        },
      }),
      ref('@docs', {
        tagName: 'a',
        role: 'link',
        name: 'Documentation',
        attributes: { href: 'https://example.test/docs' },
      }),
    ]),
  );

  assert.equal(state.revision, 1);
  assert.deepEqual(
    state.page.capabilities.find((item) => item.action === 'capture'),
    { action: 'capture', plane: 'visual', effect: 'read' },
  );
  assert.deepEqual(
    state.page.capabilities.find((item) => item.action === 'snapshot'),
    { action: 'snapshot', plane: 'semantic', effect: 'read' },
  );

  const save = state.entities.find((entity) => entity.id === '@save');
  assert.ok(save);
  assert.equal(save.kind, 'button');
  assert.equal(save.label, 'Save changes');
  assert.equal(save.attributes.value, undefined);
  assert.equal(save.attributes.class, undefined);
  assert.equal(save.attributes['data-testid'], 'save-settings');
  assert.deepEqual(
    save.capabilities.find((item) => item.action === 'click'),
    { action: 'click', plane: 'semantic', effect: 'remote-write' },
  );

  const password = state.entities.find((entity) => entity.id === '@password');
  assert.ok(password);
  assert.equal(password.kind, 'textbox');
  assert.equal(password.sensitive, true);
  assert.equal(password.text, undefined);
  assert.equal(password.attributes.value, undefined);
  assert.deepEqual(
    password.capabilities.find((item) => item.action === 'type'),
    { action: 'type', plane: 'semantic', effect: 'local' },
  );

  const docs = state.entities.find((entity) => entity.id === '@docs');
  assert.ok(docs);
  assert.deepEqual(
    docs.capabilities.find((item) => item.action === 'click'),
    { action: 'click', plane: 'semantic', effect: 'local' },
  );
});

test('diffBrowserSemanticStates reports page and entity deltas', () => {
  const previous = buildBrowserSemanticState(
    snapshot([
      ref('@save', { name: 'Save' }),
      ref('@docs', {
        tagName: 'a',
        role: 'link',
        attributes: { href: 'https://example.test/docs' },
      }),
    ]),
    4,
  );
  const current = buildBrowserSemanticState(
    snapshot(
      [
        ref('@save', {
          name: 'Save changes',
          box: { x: 10, y: 24, width: 120, height: 32 },
        }),
        ref('@cancel', { name: 'Cancel' }),
      ],
      { scroll: { x: 0, y: 240 }, canGoBack: true },
    ),
    5,
  );

  const delta = diffBrowserSemanticStates(previous, current);
  assert.equal(delta.fromRevision, 4);
  assert.equal(delta.toRevision, 5);
  assert.equal(delta.reset, false);
  assert.equal(delta.page.scrollChanged, true);
  assert.equal(delta.page.historyChanged, true);
  assert.deepEqual(delta.entities.added.map((entity) => entity.id), ['@cancel']);
  assert.deepEqual(delta.entities.updated.map((entity) => entity.id), ['@save']);
  assert.deepEqual(delta.entities.removed, ['@docs']);
  assert.equal(delta.entities.orderChanged, false);
});

test('diffBrowserSemanticStates reports pure entity reordering', () => {
  const previous = buildBrowserSemanticState(snapshot([ref('@a'), ref('@b')]), 1);
  const current = buildBrowserSemanticState(snapshot([ref('@b'), ref('@a')]), 2);

  const delta = diffBrowserSemanticStates(previous, current);
  assert.equal(delta.entities.orderChanged, true);
  assert.deepEqual(delta.entities.added, []);
  assert.deepEqual(delta.entities.removed, []);
});

test('BrowserSemanticStateTracker keeps revisions stable when state is unchanged', () => {
  const tracker = new BrowserSemanticStateTracker();
  const first = tracker.observe(snapshot([ref('@save')]));
  const unchanged = tracker.observe(snapshot([ref('@save')]));
  const changed = tracker.observe(
    snapshot([ref('@save', { name: 'Save all changes' })]),
    { sinceRevision: first.state.revision },
  );

  assert.equal(first.state.revision, 1);
  assert.equal(first.delta.reset, true);
  assert.equal(unchanged.state.revision, 1);
  assert.equal(unchanged.delta.fromRevision, 1);
  assert.equal(unchanged.delta.toRevision, 1);
  assert.deepEqual(unchanged.delta.entities.updated, []);
  assert.equal(changed.state.revision, 2);
  assert.equal(changed.delta.fromRevision, 1);
  assert.deepEqual(changed.delta.entities.updated.map((entity) => entity.id), ['@save']);
});

test('BrowserSemanticStateTracker falls back to a reset when history was pruned', () => {
  const tracker = new BrowserSemanticStateTracker(2);
  tracker.observe(snapshot([ref('@a')]));
  tracker.observe(snapshot([ref('@a'), ref('@b')]));
  tracker.observe(snapshot([ref('@a'), ref('@b'), ref('@c')]));

  const observation = tracker.read(1);
  assert.ok(observation);
  assert.equal(observation.state.revision, 3);
  assert.equal(observation.delta.fromRevision, 1);
  assert.equal(observation.delta.reset, true);
  assert.deepEqual(observation.delta.entities.added.map((entity) => entity.id), ['@a', '@b', '@c']);
});
