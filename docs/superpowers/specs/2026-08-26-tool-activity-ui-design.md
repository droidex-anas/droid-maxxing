# Tool activity UI

## Status

Approved. Implementation follows `docs/superpowers/plans/2026-08-26-tool-activity-ui.md`.

## Outcome

The chat transcript treats tool work as progressive disclosure, not a dump.

Default density is **compact**: live and completed reads, shells, and file
edits collapse into one activity group. Expanding the group shows a bounded
list of collapsed rows. Expanding a row shows a bounded shell, read, or diff.
Thoughts stay their own row.

**Verbose** is today’s longer chat: each tool is its own row, completed turns
still fold into “Worked for …”, and a click opens the shell.

`chat.tsx` stops owning this UI. Feed grouping and the transcript surfaces
move into focused modules. Call sites import those modules directly.

## Non-goals

- Redesigning Markdown, the composer, subagents dock, or Mission Control layout.
- Changing tool execution, permissions, or the sidecar protocol.
- Compatibility shims for the old inline cards.
- Per-session density. This is one global preference.
- Bouncing or orb writing animations.

## Approach

One activity model, two densities. Folded and verbose share the same extracted
cards. The setting only changes grouping and default open state.

## Visual language

Quiet chrome. Hierarchy comes from type, spacing, and one lift when a panel
actually opens.

- Collapsed headers and list rows are flat text. No card, no shadow.
- An expanded tool panel (shell, read, diff) is a rounded surface with a 1px
  `border-droid-border`, `bg-droid-surface`, and a **short** shadow so it sits
  above the transcript without looking like a modal.
- Add `--droid-shadow-sm` next to the existing `--droid-shadow` in `applyTheme`.
  Dark: `0 4px 16px rgba(0, 0, 0, 0.28)`. Light: `0 4px 14px rgba(28, 25, 23, 0.08)`.
  Expanded tool panels use `--droid-shadow-sm`. `.droid-card` keeps `--droid-shadow`.
- Do not invent extra glow, glass, or accent tints on these panels.
- Muted 13px header labels. Mono for paths and commands. Existing diff add/del
  tokens for `+n −n` and hunk coloring.
- Read uses a file icon (`FileText`). The eye icon is removed from tool chrome.

## Feed and grouping

`buildFeed` still classifies events. Density is applied in `groupTurns` /
`buildGroupedFeed`.

### Compact (default)

Contiguous `tool_activity`, `file_edit`, and `plan_update` events become one
`activity` feed item, **including the in-flight turn**. Web, search, and
skill calls are `tool_activity`, so they join that group. They do not get
their own top-level card in compact mode.

Header copy, present tense while `active`, past tense when settled. Pick the
first matching row:

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

Use the count only when it is the sole kind (“Ran 4 commands”). Mixed
file + command headers stay kind-level, like the Codex screenshots. Reads
join a file + command header without adding a third clause.

The header shimmers while the group is live. Expand shows a **max-height
16rem** list (`overflow-y: auto`) of collapsed rows. Rows stay collapsed until
clicked. Output for a row mounts only when that row is open.

Stay outside the activity group:

- thoughts
- user and assistant chat
- child-session lines and wave cards
- compaction / status
- standalone errors (no matching tool call)

A failed tool stays **inside** the group as a row with an error tag. Assistant
text is always a top-level boundary. If the model writes, then uses more
tools, that is two activity groups with the message in between.

Compact mode does **not** wrap a turn in “Worked for …”. The activity group
replaces it.

### Verbose

Current behavior. Live tools stream as their own rows (existing tool groups and
diff groups allowed). Completed turns fold into “Worked for …”. Shell cards
may start open. Same extracted cards, different grouping and default open
state.

## Extracted modules

No forwarding wrappers. Update ChatView, MissionControl, timeline hooks, and
tests to import the new files. Delete the moved code from `chat.tsx`. If
`chat.tsx` has nothing left, delete the file.

| Module | Owns |
| --- | --- |
| `src/lib/transcriptFeed.ts` | `FeedItem`, `buildFeed`, `groupTurns`, activity summary, result correlation, anchors |
| `src/lib/transcriptFeed.test.ts` | grouping tests currently in `chat.test.ts` |
| `src/components/transcript/primitives.tsx` | expand/collapse, caret, copy, working and compaction indicators, skeletons |
| `src/components/transcript/thought.tsx` | thinking row; expanded body is bounded |
| `src/components/transcript/cards.tsx` | Read, Shell, File edit, plus existing web/todo/error cards |
| `src/components/transcript/activity.tsx` | compact `ActivityGroup` and verbose `WorkedGroup` |
| `src/components/transcript/feed.tsx` | `MessageFeed`, `FeedItemView`, user bubble |

Leaf files stay around 50–250 lines. Feed and activity stay under ~400. If
`cards.tsx` crosses that, split web cards. Do not create one-function files.

Prefer obvious names, one owner per module, and direct calls. Density is a
boolean/union passed into the feed builder, not a context bag.

## Cards

Shared in both densities.

**Read.** `Read` + truncated path. File icon, not an eye. Expand: bounded
file body, `max-height: 14rem`, `overflow: auto`.

**Shell.** Collapsed: `Ran` / `Running` + truncated command. Expand: panel
titled `Shell`, `$ command`, scrollable output, success or error. Same
`max-height: 14rem` on the output. Verbose may render this panel open.

**File edit.** Collapsed: path + `+n −n`. Expand: bounded diff with line
numbers and existing diff tokens. `max-height: 14rem`. Cap how many diff
lines render in-chat; “open full diff” still uses the Review path.

Web search/fetch and todo checklists keep their current card language but use
the same expand primitive, bounded viewport, and mount-on-open rule.

## Scroll, expand, writing

### Expand

Animate a **capped panel**, not unbounded `height: auto` of the dump. Use a
CSS grid `0fr → 1fr` (or equivalent) on a wrapper whose inner scroller has
the max-height. `prefers-reduced-motion: reduce` skips the animation.

Closed rows do not mount output. Opening one row must not mount the rest.

### Transcript scroll

Pin-to-bottom follows the **chat scroller only**, and only while the user is
actually at the bottom.

- Opening a thought or activity group does not re-pin.
- Streaming thought writes inside its `max-height: 14rem` box. After the box
  is full, transcript height does not keep growing.
- If the user scrolls away, they stay put while thinking or tools continue.
- Assistant text still follows when pinned, so a normal reply does not leave
  the user stranded.

Internal scroll of a disclosure is independent of transcript pin.

### Writing

A blinking caret at the end of growing assistant text. Activity and thought
headers use existing `shimmer-text` while live. No bouncing balls.

The caret unmounts when that message is no longer the live streaming tail
(`pending` false, or a later feed item is the live one). That is the stuck
line. Reduced motion already disables caret and shimmer.

## Configuration

Configuration tab, new **Transcript** group next to Sessions.

- Label: **Tool activity**
- Options: **Compact** (default), **Verbose**
- Description: Compact folds reads, shells, and edits into one group. Verbose
  shows each tool as it runs.
- Values: `compact` \| `verbose`
- Storage: `localStorage` key `droid-tool-activity`, global, not per session
- Store field + reducer, same pattern as other UI prefs
- Changing it rebuilds the current feed immediately
- Applies everywhere `MessageFeed` renders (chat, spec, child transcript,
  Mission Control)

Settings search keywords: tool activity, compact, verbose, fold, tool calls,
step by step.

## Errors and states

- Failed tool: row in the group, error tag, expand shows error output in the
  same bounded panel (red tint already used).
- Standalone error: top-level `ErrorLine`.
- Cancellation artifacts stay hidden, as today.
- Empty command output: show the shell panel with `No output` and success
  when the tool succeeded.
- Live group with zero settled rows: header still shows, shimmering.
- Density switch mid-turn: rebuild from the same events; do not lose expand
  state for rows the user already opened if their identities still exist.

## Tests

- Compact groups mixed reads/shells/edits into one live `activity` item.
- Assistant text splits activity groups and never nests inside one.
- Thoughts, child sessions, compaction, and standalone errors stay outside.
- Failed tool remains inside the group.
- Verbose still produces current `tools` / `diff` / `worked` shapes.
- Summary copy: live vs settled, single-kind counts vs mixed kind labels.
- Result correlation and cancellation hiding still hold after the move.
- Settings persist `compact` / `verbose` and settings search hits the row.
- Caret absent on a settled assistant message.
- Expand does not mount sibling row output (render/test via presence).

Browser/UI verification after implementation: compact live turn, expand list,
expand shell and diff (bounded, shadowed, no transcript jump), expanded
thinking while streaming (user can scroll away), verbose mode matches today’s
length, caret gone when the reply finishes.

## Validation

Focused: transcript feed tests, card/activity tests, settings persistence,
`npm run typecheck`. Broader checks if ChatView/MissionControl imports move.
`npm run lint` is non-blocking; new and moved files own their diagnostics.
