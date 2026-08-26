# Tool Activity UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact tool activity in the transcript by default (Codex-style nested disclosure), with a Configuration verbose escape hatch, extracted readable modules, and UI that stays quiet, bounded, and under the user’s scroll control.

**Architecture:** One feed, two densities. `buildFeed` stays the classifier. `groupTurns` / `buildGroupedFeed` apply `compact` vs `verbose`. Compact folds contiguous reads/shells/edits into an `activity` item live and after the turn. Shared extracted cards render both densities. `chat.tsx` is emptied of this ownership.

**Tech Stack:** React 19, Tailwind, existing droid tokens, Node test runner (`node --import tsx --test`), localStorage prefs via `useStore`.

**Spec:** `docs/superpowers/specs/2026-08-26-tool-activity-ui-design.md`

**Worktree:** `.worktrees/tool-activity-ui` on `feat/tool-activity-ui` from `origin/main`. Do not touch the primary `use-store` checkout.

## Global Constraints

- Node 22.
- Compact is the product default. Verbose is today’s longer chat.
- Thoughts stay their own row. Assistant text never nests in an activity group.
- Child-session cards, compaction, and standalone errors stay outside the group.
- Failed tools stay inside the group with an error tag.
- Expanded shells/reads/diffs/thoughts/activity lists use bounded max-height (`max-h-64` list, `max-h-56` bodies) and mount output only when open.
- Expanded tool panels use `border-droid-border`, `bg-droid-surface`, and `--droid-shadow-sm`. Collapsed rows are flat (no card, no shadow).
- Read uses `FileText`, never `Eye`.
- Writing indicator is a blinking caret plus `shimmer-text` labels. No bouncing balls.
- Expand animates a capped panel (CSS grid `0fr`/`1fr`), not unbounded `height: auto`. Honor `prefers-reduced-motion`.
- Pin-to-bottom follows the chat scroller only while the user is at the bottom. Opening a disclosure does not re-pin. Streaming thought writes inside its box.
- Prefer simple, readable modules. Leaf UI ~50–250 lines, feed/activity under ~400. No one-function files. No forwarding wrappers left in `chat.tsx`.
- Every behavior change gets tests. Existing `worked` grouping tests become explicit `density: 'verbose'` tests.
- `npm run lint` is non-blocking; new and moved files own their diagnostics.

## File map

| File | Responsibility |
| --- | --- |
| `src/lib/toolActivity.ts` | Density type, load/save, default `compact` |
| `src/lib/toolActivity.test.ts` | Persistence round-trip |
| `src/lib/transcriptFeed.ts` | `FeedItem`, `buildFeed`, `groupTurns`, `summarizeActivity`, correlation, anchors |
| `src/lib/transcriptFeed.test.ts` | Grouping tests moved from `chat.test.ts` plus compact cases |
| `src/components/transcript/primitives.tsx` | Expand, caret, copy, working/compaction, skeletons |
| `src/components/transcript/thought.tsx` | Thinking row with bounded body |
| `src/components/transcript/cards.tsx` | Read, Shell, File edit, web/todo/error |
| `src/components/transcript/activity.tsx` | Compact `ActivityGroup`, verbose `WorkedGroup` |
| `src/components/transcript/feed.tsx` | `MessageFeed`, `FeedItemView`, user bubble |
| `src/components/transcript/*.test.ts` | Render tests for cards, activity, thought, expand |
| `src/hooks/useStore.tsx` | `toolActivity` field + reducer |
| `src/lib/theme.ts` / `src/index.css` | `--droid-shadow-sm` |
| `src/lib/tools.tsx` | `CAT_ICON.read = FileText` |
| `src/components/SettingsPanel.tsx` | Configuration Transcript row |
| `src/lib/settingsSearch.ts` | Search keywords |
| `src/components/ChatView.tsx` | Pass density into `buildGroupedFeed` |
| `src/components/chat.tsx` | Delete moved code; remove file if empty |
| `src/components/DiffView.tsx` | Export `DiffLines` for the file-edit card |

---

### Task 1: Tool activity density preference

**Files:**
- Create: `src/lib/toolActivity.ts`
- Create: `src/lib/toolActivity.test.ts`
- Modify: `src/hooks/useStore.tsx` (state, action, load, reducer)
- Modify: `src/components/SettingsPanel.tsx` (`ConfigurationSection`)
- Modify: `src/lib/settingsSearch.ts`
- Modify: `src/lib/settingsSearch.test.ts`
- Test: `src/lib/toolActivity.test.ts`, `src/lib/settingsSearch.test.ts`

**Interfaces:**
- Produces: `ToolActivityDensity`, `DEFAULT_TOOL_ACTIVITY_DENSITY`, `loadToolActivityDensity()`, `saveToolActivityDensity(value: ToolActivityDensity): ToolActivityDensity`, store field `toolActivity`, action `{ type: 'SET_TOOL_ACTIVITY'; density: ToolActivityDensity }`

- [ ] **Step 1: Write the failing persistence tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { withLocalStorageMap } from '../test/localStorage';
import {
  DEFAULT_TOOL_ACTIVITY_DENSITY,
  loadToolActivityDensity,
  saveToolActivityDensity,
} from './toolActivity';

test('tool activity defaults to compact', () => {
  withLocalStorageMap({}, () => {
    assert.equal(loadToolActivityDensity(), 'compact');
    assert.equal(DEFAULT_TOOL_ACTIVITY_DENSITY, 'compact');
  });
});

test('tool activity round-trips compact and verbose', () => {
  withLocalStorageMap({}, () => {
    assert.equal(saveToolActivityDensity('verbose'), 'verbose');
    assert.equal(loadToolActivityDensity(), 'verbose');
    assert.equal(saveToolActivityDensity('compact'), 'compact');
    assert.equal(loadToolActivityDensity(), 'compact');
  });
});

test('unknown stored values fall back to compact', () => {
  withLocalStorageMap({ 'droid-tool-activity': 'nope' }, () => {
    assert.equal(loadToolActivityDensity(), 'compact');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/lib/toolActivity.test.ts`

Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/toolActivity.ts`**

```ts
export type ToolActivityDensity = 'compact' | 'verbose';

export const TOOL_ACTIVITY_STORAGE_KEY = 'droid-tool-activity';
export const DEFAULT_TOOL_ACTIVITY_DENSITY: ToolActivityDensity = 'compact';

export function normalizeToolActivityDensity(value: unknown): ToolActivityDensity {
  return value === 'verbose' ? 'verbose' : 'compact';
}

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

export function loadToolActivityDensity(): ToolActivityDensity {
  try {
    return normalizeToolActivityDensity(storage()?.getItem(TOOL_ACTIVITY_STORAGE_KEY));
  } catch {
    return DEFAULT_TOOL_ACTIVITY_DENSITY;
  }
}

export function saveToolActivityDensity(value: ToolActivityDensity): ToolActivityDensity {
  const density = normalizeToolActivityDensity(value);
  try {
    storage()?.setItem(TOOL_ACTIVITY_STORAGE_KEY, density);
  } catch {
    /* ignore */
  }
  return density;
}
```

Mirror `loadDiffView` / `saveDiffView` in `useStore.tsx`: import the helpers, add `toolActivity: ToolActivityDensity` to state (initial `loadToolActivityDensity()`), add action `SET_TOOL_ACTIVITY`, reducer `return { ...state, toolActivity: saveToolActivityDensity(action.density) }`. Re-export the type from the store only if settings already import sibling types from there; prefer importing `ToolActivityDensity` from `src/lib/toolActivity.ts`.

In `ConfigurationSection`, add a Transcript group above or below Sessions:

```tsx
<GroupLabel>Transcript</GroupLabel>
<div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-8">
  <SettingRow
    label="Tool activity"
    description="Compact folds reads, shells, and edits into one group. Verbose shows each tool as it runs."
  >
    <Dropdown
      value={toolActivity}
      width="w-44"
      ariaLabel="Tool activity"
      options={[
        { value: 'compact', label: 'Compact' },
        { value: 'verbose', label: 'Verbose' },
      ]}
      onChange={(value) => {
        dispatch({
          type: 'SET_TOOL_ACTIVITY',
          density: value as ToolActivityDensity,
        });
      }}
    />
  </SettingRow>
</div>
```

Read `toolActivity` with `useStoreSelector`. Add search entry:

```ts
e('Configuration', 'Tool activity', [
  'compact',
  'verbose',
  'fold',
  'tool calls',
  'step by step',
  'transcript',
]),
```

Add to `settingsSearch.test.ts`:

```ts
assert.equal(searchSettings('tool activity')[0]?.tab, 'Configuration');
assert.equal(bestTabForQuery('verbose'), 'Configuration');
```

- [ ] **Step 4: Run tests**

Run:

```
node --import tsx --test src/lib/toolActivity.test.ts src/lib/settingsSearch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/toolActivity.ts src/lib/toolActivity.test.ts src/hooks/useStore.tsx src/components/SettingsPanel.tsx src/lib/settingsSearch.ts src/lib/settingsSearch.test.ts
git commit -m "$(cat <<'EOF'
feat: add compact/verbose tool activity setting

EOF
)"
```

---

### Task 2: Short shadow token

**Files:**
- Modify: `src/lib/theme.ts` (`applyTheme`, next to `--droid-shadow`)
- Modify: `src/index.css` (fallback on `.droid-card` comment or a new utility)
- Test: no dedicated test; verified by the token existing and later card styles using it

**Interfaces:**
- Produces: CSS variable `--droid-shadow-sm`
- Consumes: existing `bgIsDark` in `applyTheme`

- [ ] **Step 1: Set the token in `applyTheme`**

```ts
root.style.setProperty(
  '--droid-shadow',
  bgIsDark ? '0 10px 40px rgba(0, 0, 0, 0.35)' : '0 10px 30px rgba(28, 25, 23, 0.1)',
);
root.style.setProperty(
  '--droid-shadow-sm',
  bgIsDark ? '0 4px 16px rgba(0, 0, 0, 0.28)' : '0 4px 14px rgba(28, 25, 23, 0.08)',
);
```

Add to `src/index.css` near `.droid-card`:

```css
.droid-tool-panel {
  @apply overflow-hidden rounded-xl border border-droid-border bg-droid-surface;
  box-shadow: var(--droid-shadow-sm, 0 4px 16px rgba(0, 0, 0, 0.28));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/theme.ts src/index.css
git commit -m "$(cat <<'EOF'
feat: add short shadow token for expanded tool panels

EOF
)"
```

---

### Task 3: Extract feed grouping without behavior change

**Files:**
- Create: `src/lib/transcriptFeed.ts` (move feed types and pure functions from `src/components/chat.tsx`)
- Create: `src/lib/transcriptFeed.test.ts` by moving grouping tests from `src/components/chat.test.ts`
- Modify: `src/components/chat.tsx` to re-export from `transcriptFeed.ts` for this task only
- Modify: `src/components/SubagentsDock.test.ts` imports if they pull `buildFeed` / `groupTurns`
- Test: existing grouping tests, now importing from `transcriptFeed`

**Interfaces:**
- Produces: existing exports with identical signatures: `FeedItem`, `buildFeed`, `groupTurns`, `buildGroupedFeed`, `GroupedFeedOptions`, `correlateResults`, `isResultFor`, `collectTurnFiles`, `conversationAnchors`, `promptAnchorsFromItems`, `sameFeedEvents`, `isCancellationArtifact`, `appendedFeedItemKeys`, `trailingSubagentPoll`, `childSessionLineIsRunning`, `completeAppResponsesInLatestTurn`, `rememberFreshAppResponses`
- Do not add `density` yet. Default behavior remains today’s verbose grouping.

- [ ] **Step 1: Move the pure feed module**

Cut from `chat.tsx` everything that does not render React (from `FeedItem` through `groupTurns` / `buildGroupedFeed` / correlation / anchors / cancellation / sameFeedEvents). Paste into `src/lib/transcriptFeed.ts`. Keep imports that those functions need (`classifyEvent`, `extractFileChange`, `toolMeta`, child-session helpers, `TurnFile` from `TurnChangesPanel`).

At the bottom of `chat.tsx` for this task only:

```ts
export {
  buildFeed,
  buildGroupedFeed,
  groupTurns,
  correlateResults,
  isResultFor,
  collectTurnFiles,
  conversationAnchors,
  promptAnchorsFromItems,
  sameFeedEvents,
  isCancellationArtifact,
  appendedFeedItemKeys,
  trailingSubagentPoll,
  childSessionLineIsRunning,
  completeAppResponsesInLatestTurn,
  rememberFreshAppResponses,
  type FeedItem,
  type GroupedFeedOptions,
  type ConversationAnchor,
} from '../lib/transcriptFeed';
```

Move the grouping tests that import those names into `src/lib/transcriptFeed.test.ts` and import from `./transcriptFeed`. Leave UI tests (`MessageFeed`, `UserBubble`, `WebFetchBody`, `StreamingCaret`) in `chat.test.ts`.

- [ ] **Step 2: Run the moved tests**

Run:

```
node --import tsx --test src/lib/transcriptFeed.test.ts src/components/chat.test.ts src/components/SubagentsDock.test.ts
```

Expected: PASS, same assertions as before the move.

- [ ] **Step 3: Commit**

```bash
git add src/lib/transcriptFeed.ts src/lib/transcriptFeed.test.ts src/components/chat.tsx src/components/chat.test.ts src/components/SubagentsDock.test.ts
git commit -m "$(cat <<'EOF'
refactor: extract transcript feed grouping from chat.tsx

EOF
)"
```

---

### Task 4: Compact activity grouping

**Files:**
- Modify: `src/lib/transcriptFeed.ts`
- Modify: `src/lib/transcriptFeed.test.ts`
- Modify: existing tests that expect `worked` on a completed mixed turn (pass `density: 'verbose'`)

**Interfaces:**
- Consumes: `ToolActivityDensity` from `src/lib/toolActivity.ts`
- Produces:

```ts
export type ActivityFeedItem = {
  type: 'activity';
  key: string;
  items: FeedItem[];
  active: boolean;
};

// FeedItem union includes ActivityFeedItem

export function summarizeActivity(items: FeedItem[], active: boolean): string;

export function groupTurns(
  items: FeedItem[],
  pending: boolean,
  specContent?: string,
  changes?: boolean,
  density?: ToolActivityDensity, // default 'verbose' here so old tests stay stable
): FeedItem[];

export type GroupedFeedOptions = BuildFeedOptions & {
  specContent?: string;
  changes?: boolean;
  density?: ToolActivityDensity;
};
```

`buildGroupedFeed` passes `options.density ?? 'compact'` so the product entry defaults compact. Direct `groupTurns` calls in old tests stay verbose unless they pass compact.

Helper: a feed item is foldable when `type` is `'tools' | 'diff' | 'diffs'`.

```ts
function isFoldableToolItem(it: FeedItem): boolean {
  return it.type === 'tools' || it.type === 'diff' || it.type === 'diffs';
}

export function foldActivityItems(items: FeedItem[], trailingLive: boolean): FeedItem[] {
  const out: FeedItem[] = [];
  let buf: FeedItem[] = [];
  const flush = (active: boolean) => {
    if (buf.length === 0) return;
    out.push({
      type: 'activity',
      key: `activity-${buf[0].key}`,
      items: [...buf],
      active,
    });
    buf = [];
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (isFoldableToolItem(it)) buf.push(it);
    else {
      flush(false);
      out.push(it);
    }
  }
  const live = trailingLive && buf.length > 0;
  flush(live);
  return out;
}
```

In compact mode, `groupTurns` runs `foldActivityItems` on each assistant run, including the in-flight last run. It does **not** call `collapseRun` (no `worked`). `turnChanges` still appends on completed runs when `changes` is true. Verbose mode keeps `collapseRun` and live-expanded last run.

`summarizeActivity` counts tool cats via `toolMeta` on `tools` events plus file-edit items:

| Contents | Live | Settled |
| --- | --- | --- |
| files and commands | Editing files, running commands | Edited files, ran commands |
| commands only | Running N commands | Ran N commands |
| files edited only | Editing files | Edited files |
| reads only | Reading files | Read N files |
| searches only | Searching | Searched |
| fetches only | Fetching | Fetched pages |
| plan only | Updating plan | Updated plan |
| anything else mixed | Working | Ran tools |

Use the count only when it is the sole kind. Reads join a file+command header without a third clause.

Update `sameFeedEvents` / `spanOf` / `tailTimestamp` for `activity` the same way as `tools` (compare nested items/events).

- [ ] **Step 1: Write failing compact tests** in `src/lib/transcriptFeed.test.ts`

Reuse the `ev` helper. Sketch:

```ts
test('compact folds live reads, shells, and edits into one activity group', () => {
  const events = [
    userMsg('do it'),
    ev({ kind: 'thinking', text: 'plan' }),
    ev({ kind: 'tool_call', toolName: 'Read', toolArgs: { file_path: 'a.ts' } }),
    ev({ kind: 'tool_call', toolName: 'Execute', toolArgs: { command: 'npm test' } }),
    ev({
      kind: 'tool_call',
      toolName: 'Edit',
      toolArgs: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
    }),
  ];
  const items = buildGroupedFeed(events, true, { density: 'compact' });
  const types = items.map((it) => it.type);
  assert.deepEqual(types, ['message', 'thinking', 'activity']);
  const activity = items[2];
  assert.equal(activity.type, 'activity');
  if (activity.type === 'activity') {
    assert.equal(activity.active, true);
    assert.match(summarizeActivity(activity.items, true), /editing files, running commands/i);
  }
});

test('compact keeps thoughts and assistant text outside the activity group', () => {
  const events = [
    userMsg('q'),
    ev({ kind: 'tool_call', toolName: 'Execute', toolArgs: { command: 'ls' } }),
    asst('done'),
    ev({ kind: 'tool_call', toolName: 'Execute', toolArgs: { command: 'pwd' } }),
  ];
  const items = buildGroupedFeed(events, false, { density: 'compact' });
  assert.equal(items.filter((it) => it.type === 'activity').length, 2);
  assert.ok(items.some((it) => it.type === 'message' && it.event.text === 'done'));
  assert.ok(!items.some((it) => it.type === 'worked'));
});

test('compact keeps standalone errors and child sessions outside', () => {
  const events = [
    userMsg('q'),
    ev({ kind: 'tool_call', toolName: 'Grep', toolArgs: { pattern: 'x' } }),
    ev({ kind: 'error', text: 'boom', isError: true }),
    ev({
      kind: 'tool_call',
      toolName: 'Task',
      toolArgs: { subagent_type: 'explore', description: 'look around' },
    }),
  ];
  const items = buildGroupedFeed(events, false, {
    density: 'compact',
    childSessionCards: true,
  });
  assert.ok(items.some((it) => it.type === 'error'));
  assert.ok(items.some((it) => it.type === 'child_session' || it.type === 'child_sessions'));
  for (const it of items) {
    if (it.type !== 'activity') continue;
    assert.ok(!it.items.some((child) => child.type === 'error' || child.type === 'child_session'));
  }
});

test('compact failed execute stays inside the activity group', () => {
  const call = ev({
    kind: 'tool_call',
    toolName: 'Execute',
    toolArgs: { command: 'npm test' },
    toolUseId: 'e1',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'e1',
    isError: true,
    text: 'permission denied',
  });
  const items = buildGroupedFeed([userMsg('q'), call, failed], false, { density: 'compact' });
  const activity = items.find((it) => it.type === 'activity');
  assert.ok(activity && activity.type === 'activity');
  const tools = activity.items.find((it) => it.type === 'tools');
  assert.ok(tools && tools.type === 'tools');
  assert.ok(tools.events.includes(failed));
});

test('verbose still folds a completed turn into worked', () => {
  const events = [userMsg('q'), grep(), asst('answer')];
  const items = buildGroupedFeed(events, false, { density: 'verbose' });
  assert.ok(items.some((it) => it.type === 'worked'));
});
```

For the edit event, use whatever `extractFileChange` already recognizes in `src/lib/diff.ts` (Write/Edit/StrReplace args). If a synthetic edit does not classify as `file_edit`, fix the fixture rather than weakening the test.

- [ ] **Step 2: Run tests, expect FAIL**

Run: `node --import tsx --test src/lib/transcriptFeed.test.ts`

Expected: FAIL on missing `summarizeActivity` / `activity` type.

- [ ] **Step 3: Implement grouping**

Add the types, `foldActivityItems`, `summarizeActivity`, density argument. Mark every existing `buildGroupedFeed(events, false)` test that asserts `worked` with `{ density: 'verbose' }` (or keep `groupTurns` default `'verbose'` and only `buildGroupedFeed` default compact).

- [ ] **Step 4: Run tests, expect PASS**

Run:

```
node --import tsx --test src/lib/transcriptFeed.test.ts src/components/chat.test.ts src/components/SubagentsDock.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/transcriptFeed.ts src/lib/transcriptFeed.test.ts src/components/chat.test.ts
git commit -m "$(cat <<'EOF'
feat: fold live tool work into compact activity groups

EOF
)"
```

---

### Task 5: Expand primitive, caret, read icon

**Files:**
- Create: `src/components/transcript/primitives.tsx`
- Create: `src/components/transcript/primitives.test.ts`
- Modify: `src/lib/tools.tsx` (`CAT_ICON.read`)
- Modify: `src/lib/tools.test.ts`
- Modify: `src/components/chat.tsx` to import Expand/Caret/StreamingCaret from primitives (temporary)

**Interfaces:**
- Produces:

```ts
export function Expand(props: { open: boolean; children: React.ReactNode }): JSX.Element;
export function Caret(props: { open: boolean }): JSX.Element;
export function StreamingCaret(): JSX.Element;
export function WorkingIndicator(props: { label?: string; startTs?: number }): JSX.Element;
export function ToolPanel(props: { children: React.ReactNode; className?: string }): JSX.Element;
```

`ToolPanel` is the shadowed bounded chrome: `droid-tool-panel` + optional `max-h-56 overflow-y-auto`.

`Expand` must:
- use CSS grid `grid-rows-[0fr]` / `grid-rows-[1fr]` with `min-h-0 overflow-hidden` inner
- `motion-reduce:transition-none`
- mount children only when `open` is true

- [ ] **Step 1: Failing tests**

```ts
test('CAT_ICON.read is FileText not Eye', () => {
  assert.equal(CAT_ICON.read, FileText);
});

test('Expand omits children when closed', () => {
  const closed = renderToStaticMarkup(
    createElement(Expand, { open: false }, createElement('pre', null, 'SECRET')),
  );
  assert.equal(closed.includes('SECRET'), false);
  const opened = renderToStaticMarkup(
    createElement(Expand, { open: true }, createElement('pre', null, 'SECRET')),
  );
  assert.equal(opened.includes('SECRET'), true);
});
```

- [ ] **Step 2: Implement**

Move `StreamingCaret`, `WorkingIndicator`, skeletons, compaction divider, `CopyButton`, `ErrorTag`, `Caret` from `chat.tsx` into `primitives.tsx`. Replace the old `height: auto` framer `Expand` with the grid version.

```tsx
export function Expand({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      }`}
    >
      <div className="min-h-0 overflow-hidden">{open ? children : null}</div>
    </div>
  );
}

export function ToolPanel({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`droid-tool-panel ${className}`}>{children}</div>;
}
```

`CAT_ICON.read = FileText`. Drop the `Eye` import if unused.

- [ ] **Step 3: Run tests**

```
node --import tsx --test src/components/transcript/primitives.test.ts src/lib/tools.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/transcript/primitives.tsx src/components/transcript/primitives.test.ts src/lib/tools.tsx src/lib/tools.test.ts src/components/chat.tsx
git commit -m "$(cat <<'EOF'
feat: add capped transcript expand chrome and file-icon reads

EOF
)"
```

---

### Task 6: Read, Shell, and File-edit cards

**Files:**
- Create: `src/components/transcript/cards.tsx`
- Create: `src/components/transcript/cards.test.ts`
- Modify: `src/components/DiffView.tsx` (export `DiffLines`)
- Modify: `src/components/chat.tsx` to use the new cards from `renderToolEvents`

**Interfaces:**
- Consumes: `Expand`, `ToolPanel`, `CopyButton`, `ErrorTag`, `Caret` from primitives; `extractFileChange` / `FileChange`; `toolMeta`, `stripAnsi`, `parseWebSearch`, `parseWebFetch`
- Produces:

```ts
export function ReadCard(props: {
  event: TranscriptEvent;
  output?: string;
  error?: boolean;
  defaultOpen?: boolean;
}): JSX.Element;

export function ShellCard(props: {
  command: string;
  output?: string;
  running?: boolean;
  error?: boolean;
  defaultOpen?: boolean;
}): JSX.Element;

export function FileEditCard(props: {
  change: FileChange;
  defaultOpen?: boolean;
  onOpen?: () => void;
}): JSX.Element;
```

Visual contract:
- Collapsed: flat row, 13px muted label, mono path/command, no shadow.
- Expanded: `ToolPanel` + `max-h-56 overflow-y-auto` body. Shell title `Shell`, `$` prompt, `No output` when empty success, error tint on failure.
- File edit: path + `+n −n`, line numbers in the diff body (gutter with index), existing `--diff-add-*` / `--diff-del-*`.
- `defaultOpen` true only for verbose shells (today’s longer chat). Compact always false.

- [ ] **Step 1: Failing render tests**

```ts
test('read card uses Read label and hides output until expanded', () => {
  const event = ev({ kind: 'tool_call', toolName: 'Read', toolArgs: { file_path: 'src/a.ts' } });
  const html = renderToStaticMarkup(
    createElement(ReadCard, { event, output: 'line one\nline two' }),
  );
  assert.match(html, />Read</);
  assert.match(html, /src\/a\.ts/);
  assert.equal(html.includes('line one'), false);
});

test('shell card collapsed does not mount command output', () => {
  const html = renderToStaticMarkup(
    createElement(ShellCard, { command: 'npm test', output: 'FAIL pretty long' }),
  );
  assert.match(html, /npm test/);
  assert.equal(html.includes('FAIL pretty long'), false);
});

test('verbose shell defaultOpen mounts output in a bounded panel', () => {
  const html = renderToStaticMarkup(
    createElement(ShellCard, {
      command: 'ls',
      output: 'a.ts',
      defaultOpen: true,
    }),
  );
  assert.match(html, /a\.ts/);
  assert.match(html, /droid-tool-panel|max-h-56/);
});
```

- [ ] **Step 2: Implement the three cards**

Keep web/todo/error renderers in this file too by moving `WebSearchCard`, `WebFetchCard`, `TodoChecklist`, `ErrorLine`, `CommandCard`/`ToolLine` replacements. `renderToolEvents` then only switches on cat and returns these cards.

Shell collapsed label: `Running` when `running`, `Ran` otherwise. Read collapsed: `Read` + path. Never `Eye`.

Diff body: export `DiffLines` from `DiffView.tsx` and add a line-number gutter (1-based index per op, muted). Cap preview length as today’s 14-line preview plus “open full diff”.

- [ ] **Step 3: Run tests**

```
node --import tsx --test src/components/transcript/cards.test.ts src/components/chat.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/components/transcript/cards.tsx src/components/transcript/cards.test.ts src/components/DiffView.tsx src/components/chat.tsx
git commit -m "$(cat <<'EOF'
feat: add bounded read, shell, and file-edit transcript cards

EOF
)"
```

---

### Task 7: Activity group and thought row

**Files:**
- Create: `src/components/transcript/activity.tsx`
- Create: `src/components/transcript/activity.test.ts`
- Create: `src/components/transcript/thought.tsx`
- Create: `src/components/transcript/thought.test.ts`

**Interfaces:**
- Consumes: `ActivityFeedItem`, `summarizeActivity`, cards, `Expand`, `ToolPanel`
- Produces:

```ts
export function ActivityGroup(props: {
  item: Extract<FeedItem, { type: 'activity' }>;
  onOpenDiff?: (change: FileChange) => void;
}): JSX.Element;

export function WorkedGroup(props: {
  item: Extract<FeedItem, { type: 'worked' }>;
  onOpenDiff?: (change: FileChange) => void;
  onOpenChildSession?: (target: ChildSessionTarget) => void;
  childSessionActivity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  subagentsDock?: SubagentsDockData;
  specContent?: string;
}): JSX.Element;

export function ThoughtCard(props: {
  text: string;
  durationMs?: number;
  active?: boolean;
  startTs?: number;
}): JSX.Element;
```

`ActivityGroup`:
- Header button: caret + `summarizeActivity(item.items, item.active)` with `shimmer-text` while `item.active`.
- Expand → `max-h-64 overflow-y-auto` list of rows. No outer shadow on the list.
- Each row is a Read/Shell/FileEdit card with `defaultOpen={false}`.
- Do not mount every card’s output just because the group is open.

`ThoughtCard`:
- Same header as today’s Thinking/Thought.
- Expanded body: `max-h-56 overflow-y-auto` muted text. If `active` and the inner scroller is at its own bottom, keep it pinned inside the box (local ref, not the transcript pin).
- Caret only inside the expanded body while `active`.

- [ ] **Step 1: Failing tests**

```ts
test('activity header uses mixed compact copy and list stays collapsed', () => {
  // render ActivityGroup with tools+diff items, assert header text, assert shell output absent
});

test('thought body is bounded and omitted when collapsed', () => {
  const html = renderToStaticMarkup(
    createElement(ThoughtCard, { text: 'secret chain of thought', active: true }),
  );
  assert.equal(html.includes('secret chain of thought'), false);
  assert.match(html, /Thinking/);
});
```

- [ ] **Step 2: Implement**

Move `WorkedGroup` here. Verbose still uses it.

- [ ] **Step 3: Run tests**

```
node --import tsx --test src/components/transcript/activity.test.ts src/components/transcript/thought.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/components/transcript/activity.tsx src/components/transcript/activity.test.ts src/components/transcript/thought.tsx src/components/transcript/thought.test.ts
git commit -m "$(cat <<'EOF'
feat: add compact activity group and bounded thought row

EOF
)"
```

---

### Task 8: Wire MessageFeed and ChatView

**Files:**
- Create: `src/components/transcript/feed.tsx` (move `MessageFeed`, `FeedItemView`, `UserBubble`)
- Modify: `src/components/ChatView.tsx`
- Modify: `src/components/MissionControl.tsx` import
- Modify: `src/hooks/useConversationTimeline.ts`, `src/hooks/conversationViewportAnchor.ts` to import `FeedItem` from `transcriptFeed`
- Modify: `src/components/chat.tsx` — delete moved UI; keep only re-exports if something still needs a tick, then delete those too
- Modify remaining tests’ import paths

**Interfaces:**
- Consumes: `state.toolActivity` from the store
- `buildGroupedFeed(events, pending, { ..., density })`
- `FeedItemView` case `'activity'` → `<ActivityGroup />`
- `FeedItemView` case `'thinking'` → `<ThoughtCard />`

- [ ] **Step 1: Pass density from ChatView**

```ts
const toolActivity = useStoreSelector((s) => s.toolActivity);
const feedItems = useMemo(
  () =>
    buildGroupedFeed(transcript, live, {
      childSessionCards: true,
      specContent,
      changes: true,
      groupChildSessions: !viewingChildSession,
      density: toolActivity,
    }),
  [transcript, live, specContent, viewingChildSession, toolActivity],
);
```

Mission Control’s `MessageFeed` uses the same store density (global).

`sameFeedEvents` / memo compare must treat `activity` like `tools`. Live activity groups re-render while `active` (include `activity` in the always-re-render set next to `worked`).

Streaming caret on assistant messages: only when `live` is true for that message (already the `FeedItemView` `live` flag). Confirm `MessageFeed` sets `live` only on the streaming tail item. If a settled message still gets `live`, fix that here — that is the stuck caret.

- [ ] **Step 2: Run tests**

```
node --import tsx --test src/lib/transcriptFeed.test.ts src/components/chat.test.ts src/components/transcript/*.test.ts src/components/SubagentsDock.test.ts
```

Expected: PASS.

- [ ] **Step 3: Delete empty re-exports**

Grep `from './chat'` and `from '../components/chat'`. Point every caller at `transcript/feed`, `transcript/primitives`, or `lib/transcriptFeed`. Delete `chat.tsx` if it has no remaining implementation. If a handful of UI helpers remain, keep a small `chat.tsx` only for those leftovers — do not leave one-line wrappers.

- [ ] **Step 4: Commit**

```bash
git add src/components/transcript/feed.tsx src/components/ChatView.tsx src/components/MissionControl.tsx src/hooks/useConversationTimeline.ts src/hooks/conversationViewportAnchor.ts src/components/chat.tsx src/components/chat.test.ts
git commit -m "$(cat <<'EOF'
feat: render compact tool activity in the chat feed

EOF
)"
```

---

### Task 9: Scroll ownership for expanded thinking

**Files:**
- Modify: `src/components/transcript/thought.tsx`
- Modify: `src/hooks/useConversationScrollWindow.ts` only if expanding still re-pins after Task 7
- Test: `src/hooks/useConversationScrollWindow.test.ts` (pure helpers only — do not add sleeps)

**Interfaces:**
- Thought inner scroller: `ref`, `onScroll` sets `innerPinned` when within 8px of its own bottom. While `active && open && innerPinned`, assign `el.scrollTop = el.scrollHeight` on text change.
- Transcript pin: keep the existing 80px rule. Do not set `isPinned.current = true` when a disclosure opens. The existing ResizeObserver already no-ops while pinned; expanding while unpinned must keep the viewport anchor (already the observer path).

If a code path currently scrolls `element.scrollTop = scrollHeight` on any resize while pinned, that is correct for assistant tokens and must remain. Bounded thought is what stops that from dragging the user through an unbounded dump.

- [ ] **Step 1: Add a pure helper if needed**

```ts
export function isScrollerPinned(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, slackPx = 8): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slackPx;
}
```

Test it. Use it in `ThoughtCard`.

- [ ] **Step 2: Commit**

```bash
git add src/components/transcript/thought.tsx src/hooks/useConversationScrollWindow.ts src/hooks/useConversationScrollWindow.test.ts
git commit -m "$(cat <<'EOF'
fix: keep expanded thinking from stealing transcript scroll

EOF
)"
```

---

### Task 10: UI/UX pass and extraction cleanup

**Files:**
- Any leftover in `src/components/chat.tsx`
- `src/components/transcript/*` polish (spacing, focus rings, `aria-expanded`)
- Docs only if settings copy needs `docs:generate` (not required unless env/scripts changed)

**UX checklist (must all be true before claiming done):**

1. Compact live turn: one shimmering header, chat stays short.
2. Expand group: bounded list, rows still collapsed, no page-long jump.
3. Expand shell: shadowed `droid-tool-panel`, `$` command, output scrolls inside, transcript does not grow with output length.
4. Expand diff: line numbers, add/del color, same bounded lift.
5. Read: file icon, no eye, bounded body.
6. Thought: separate row; expand while streaming; user can scroll the transcript away and stay there; thought text scrolls inside the box.
7. Assistant caret: visible while tokens arrive, gone when the turn settles. No bouncing animation.
8. Verbose setting: immediate rebuild, each tool a row, shells open like today, completed **Worked for …** still works.
9. Keyboard: headers are buttons, focus visible, `aria-expanded` matches open state.
10. Reduced motion: expands do not animate.
11. Light and dark: `--droid-shadow-sm` lifts the panel without a dirty halo.
12. `chat.tsx` is no longer a god file; new files are under the size bar and readable.

- [ ] **Step 1: Run focused then typecheck**

```
node --import tsx --test src/lib/toolActivity.test.ts src/lib/transcriptFeed.test.ts src/lib/tools.test.ts src/lib/settingsSearch.test.ts src/components/transcript/*.test.ts src/components/chat.test.ts src/components/SubagentsDock.test.ts
npx tsc --noEmit
```

Expected: PASS / no errors.

- [ ] **Step 2: Manual Electron pass**

```
npm run electron
```

Exercise compact and verbose on a real turn with thinking, reads, commands, and edits. Confirm the UX checklist. If a visual defect shows (weak hierarchy, jank, stuck caret, shadow too heavy), fix it in the owning module before committing.

- [ ] **Step 3: Commit**

```bash
git add src/components/transcript src/components/chat.tsx src/components/ChatView.tsx
git commit -m "$(cat <<'EOF'
polish: quiet tool activity chrome and finish chat.tsx extraction

EOF
)"
```

---

## Spec coverage

| Spec section | Task |
| --- | --- |
| Compact/verbose setting, storage, search | 1 |
| `--droid-shadow-sm`, flat collapsed rows | 2, 6, 10 |
| Extract feed logic | 3 |
| Compact grouping, headers, exclusions | 4 |
| Expand primitive, no eye icon, caret chrome | 5 |
| Read/Shell/File-edit cards, mount-on-open | 6 |
| Activity group, thought viewport | 7 |
| Wire feed, product default compact | 8 |
| Scroll ownership, stuck caret | 8, 9 |
| Extraction complete, UX quality | 10 |
| Failed tools inside group | 4, 6 |
| Verbose = current Worked-for | 4, 8 |

## Notes for implementers

- Do not default `groupTurns` itself to compact until old tests pass `density: 'verbose'`. `buildGroupedFeed` is the product default (`compact`).
- Do not mount shell output for every row when the activity group opens.
- Do not reintroduce framer-motion `height: auto` for these disclosures.
- Do not put thoughts, child sessions, or assistant prose inside `activity.items`.
