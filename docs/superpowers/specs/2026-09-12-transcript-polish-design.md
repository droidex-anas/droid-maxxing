# Transcript polish — indicators, actions, motion, typography

Branch `claude/design-typography-polish-c60f3f`, from `origin/main` 8c775b32.

## Why

After PR #220 the transcript has three visible problems: the "Working" line and
message actions land in the wrong place relative to the rows around them, the
hover copy buttons take layout space that appears only after a turn settles,
and the type scale drifted into half-pixel sizes and uneven row rhythm. The
screenshot that started this (a sent prompt drawn beside the previous reply
with "Working 29s…" jammed under a copy icon) is a layout that changed height
after the virtualized row was measured.

## Principles

1. **A row never changes height after it settles.** Anything that appears when
   a turn ends (copy, actions) is an overlay with no layout footprint. Live rows
   may grow while streaming; nothing grows or shrinks at settle time.
2. **One live cue at a time.** While tokens flow, the caret alone says so, inline
   at the end of the last line. When nothing is flowing, a single "Working" line
   sits in the feed rhythm. Thinking, Running and child-session tails speak for
   themselves. Never two cues for one state.
3. **One rhythm.** Rows are 16px apart. A turn boundary (a user prompt) gets
   8px more air above it. No hidden elements pad the rhythm.
4. **Controls appear on hover or focus, in place.** They fade in over the row,
   aligned to the text edge, and never move the text.
5. **Motion is short and physical.** A sent prompt rises 10px over 320ms; rows
   enter with 4px over 200ms; nothing scales. Reduced motion disables all of it.
6. **One type scale.** 14 body · 13 rows and labels · 12 meta and code · 11
   micro. No half pixels. Monospace only inside code and command content.

## Changes

### Assistant message (`chat.tsx`)
- Actions become a floating toolbar anchored to the message's top-right,
  straddling the top edge (`-translate-y-1/2`), on a surface with a hairline
  border. Hidden until hover or focus-within. Zero layout footprint.
- The streaming caret moves into the text: a CSS pseudo-element on the last
  block of the markdown shell (`.md-typing`), so it sits at the end of the last
  line instead of wrapping onto its own line.

### User prompt (`UserBubble.tsx`)
- Copy floats outside the bubble's left edge, bottom-aligned, on hover. The
  reserved 24px action row under every bubble goes away.
- Prompt rows get `pt-2` so a new turn reads as a group.

### Working indicator (`MessageFeed.tsx`, `primitives.tsx`)
- Hidden while the tail message is actively streaming (caret owns that state);
  shown once the stream idles or when the tail is a tool run.
- Fixed line box (20px) and a 160ms fade so it never jitters or pops.
- Label ladder unchanged: Working / Running / Updating files / Checking subagents.

### Row measurement
- `ConversationList` already re-measures every mounted row after each commit
  (`syncMeasureConversationList`), including the commit that settles a turn.
  With no settle-time height changes left, that path has nothing to correct;
  no virtualizer changes are needed.

### Tool rows (`rows.tsx`, `commandCard.tsx`, `groups.tsx`)
- Error tag sits beside the label (gap 8px), not pushed to the far right.
- Row labels 13px; paths 13px sans muted; commands mono 12px.
- Half-pixel sizes removed (12.5 → 13, 11.5 → 12).

### Motion (`index.css`)
- `prompt-enter`: translateY(10px) → 0 over 320ms, no scale.
- `feed-row-enter`: 4px over 200ms (was 240ms).

### Column alignment (`PromptInput.tsx`)
- Composer text edge aligns with the transcript text edge (shared column width
  plus the composer's own inset), so the prompt you type lands where it will
  read.

## Out of scope
Right panel, sidebar, welcome screen, composer internals, code card chrome.

## Verification
Isolated Electron instance (scratch HOME, own user-data dir, replay sidecar on
port 0) with a seeded transcript and a slow replay turn; screenshots at top,
bottom, hover, expanded fold, mid-stream and idle-working. Existing test suites
stay green; no new test files unless a behaviour has no coverage at all.
