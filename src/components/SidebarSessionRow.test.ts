import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionRow, areSessionRowPropsEqual, type SessionRowProps } from './SidebarSessionRow';
import type { SessionSummary } from '../types/bridge';
import { droidSessionConfiguration } from '../lib/sessionConfiguration';

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    appSessionId: 'sess-a',
    sessionPurpose: 'chat',
    role: 'primary',
    title: 'Build the thing',
    goal: '',
    cwd: '',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'off',
    }),
    phase: 'completed',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeProps(overrides: Partial<SessionRowProps> = {}): SessionRowProps {
  return {
    session: makeSession(),
    title: 'Build the thing',
    active: false,
    unread: false,
    running: false,
    attention: null,
    renaming: false,
    now: 5_000,
    onSelect: () => undefined,
    onMenu: () => undefined,
    onRenameCommit: () => undefined,
    onRenameCancel: () => undefined,
    ...overrides,
  };
}

const render = (props: SessionRowProps) => renderToStaticMarkup(createElement(SessionRow, props));

// Stable callbacks shared across prop pairs so only the tested field differs.
const STABLE = {
  onSelect: () => undefined,
  onMenu: () => undefined,
  onRenameCommit: () => undefined,
  onRenameCancel: () => undefined,
};

test('areSessionRowPropsEqual ignores unrelated session updates', () => {
  const prev = makeProps({ session: makeSession(), ...STABLE });
  const next = makeProps({
    session: makeSession({ contextTokens: 500, tokensIn: 200, tokensOut: 300 }),
    ...STABLE,
  });
  assert.equal(areSessionRowPropsEqual(prev, next), true);
  // The harness title is not row-visible (the resolved `title` prop is), so a
  // title-only summary change must not re-render the row.
  const retitled = makeProps({ session: makeSession({ title: 'New generated' }), ...STABLE });
  assert.equal(areSessionRowPropsEqual(prev, retitled), true);
});

test('areSessionRowPropsEqual detects row-visible session updates', () => {
  const base = makeProps({ ...STABLE });
  const changes: Partial<SessionSummary>[] = [{ appSessionId: 'sess-b' }, { updatedAt: 2_000 }];

  for (const change of changes) {
    const next = makeProps({ session: makeSession(change), ...STABLE });
    assert.equal(areSessionRowPropsEqual(base, next), false);
  }
});

test('areSessionRowPropsEqual: display title change is not equal', () => {
  const props = makeProps({ ...STABLE });
  assert.equal(
    areSessionRowPropsEqual({ ...props, title: 'Old' }, { ...props, title: 'New' }),
    false,
  );
});

test('areSessionRowPropsEqual: active change is not equal', () => {
  const props = makeProps();
  assert.equal(
    areSessionRowPropsEqual({ ...props, active: false }, { ...props, active: true }),
    false,
  );
});

test('areSessionRowPropsEqual: unread change is not equal', () => {
  const props = makeProps();
  assert.equal(
    areSessionRowPropsEqual({ ...props, unread: false }, { ...props, unread: true }),
    false,
  );
});

test('areSessionRowPropsEqual: running change is not equal', () => {
  const props = makeProps();
  assert.equal(
    areSessionRowPropsEqual({ ...props, running: false }, { ...props, running: true }),
    false,
  );
});

test('areSessionRowPropsEqual: attention change is not equal', () => {
  const props = makeProps();
  assert.equal(
    areSessionRowPropsEqual({ ...props, attention: null }, { ...props, attention: 'approval' }),
    false,
  );
});

test('areSessionRowPropsEqual: now change is not equal', () => {
  const props = makeProps();
  assert.equal(areSessionRowPropsEqual({ ...props, now: 5_000 }, { ...props, now: 35_000 }), false);
});

test('areSessionRowPropsEqual: renaming change is not equal', () => {
  const props = makeProps();
  assert.equal(
    areSessionRowPropsEqual({ ...props, renaming: false }, { ...props, renaming: true }),
    false,
  );
});

test('areSessionRowPropsEqual: a new callback identity is not equal', () => {
  const session = makeSession();
  const prev = makeProps({ session, onMenu: () => undefined });
  const next = makeProps({ session, onMenu: () => undefined });
  assert.equal(areSessionRowPropsEqual(prev, next), false);
});

test('SessionRow renders the display title and targets the row by appSessionId', () => {
  const html = render(
    makeProps({
      session: makeSession({ appSessionId: 'sess-a', title: 'Generated' }),
      title: 'Renamed',
    }),
  );
  assert.match(html, /Renamed/);
  assert.doesNotMatch(html, /Generated/);
  assert.match(html, /data-app-session-id="sess-a"/);
});

test('SessionRow renders a hidden-until-hover actions button', () => {
  const html = render(makeProps());
  assert.match(html, /aria-label="Actions for Build the thing"/);
});

test('SessionRow in rename mode renders an inline editor instead of the row', () => {
  const html = render(makeProps({ renaming: true, title: 'Old name' }));
  assert.match(html, /aria-label="Rename Old name"/);
  assert.match(html, /value="Old name"/);
  assert.doesNotMatch(html, /data-testid="session-row"/);
});

test('SessionRow: the active row exposes aria-current, an unread row exposes a hidden label', () => {
  assert.match(render(makeProps({ active: true })), /aria-current="true"/);
  assert.doesNotMatch(render(makeProps({ active: false })), /aria-current/);
  assert.match(render(makeProps({ unread: true })), /sr-only">Unread:</);
  assert.doesNotMatch(render(makeProps({ unread: false })), /Unread:/);
});

test('SessionRow: a running row shows the spinner alongside the timestamp', () => {
  const html = render(makeProps({ running: true, now: 60_000 }));
  // motion-safe keeps the spinner still for reduced-motion users.
  assert.match(html, /motion-safe:animate-spin/);
  assert.match(html, />now</);
});

test('SessionRow: attention replaces both the working spinner and timestamp', () => {
  const html = render(makeProps({ running: true, attention: 'approval', now: 60_000 }));
  assert.match(html, /Waiting for approval:/);
  assert.match(html, />Awaiting approval</);
  assert.match(html, /bg-droid-green\/15/);
  assert.match(html, /text-droid-green/);
  assert.doesNotMatch(html, /animate-spin/);
  assert.doesNotMatch(html, />now</);
});

test('SessionRow: question attention uses the question label', () => {
  const html = render(makeProps({ attention: 'question' }));
  assert.match(html, /Waiting for an answer:/);
  assert.match(html, />Awaiting answer</);
});

test('SessionRow: an idle row shows the relative timestamp and no spinner', () => {
  const html = render(makeProps({ running: false, now: 60_000 }));
  assert.doesNotMatch(html, /animate-spin/);
  assert.match(html, />now</);
});

test('SessionRow: the title rests truncated inside an overflow viewport, marquee only on hover', () => {
  // The marquee sweep needs a measured overflow, so at rest (and in SSR) the
  // title stays truncated; `title-marquee` is only applied from mouseenter.
  const html = render(makeProps({ title: 'A chat name far too long for the sidebar row width' }));
  assert.match(html, /overflow-hidden/);
  assert.match(html, /truncate/);
  assert.doesNotMatch(html, /title-marquee/);
});
