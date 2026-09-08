# Activity inbox

The sidebar Activity view becomes an inbox of chats that need the user, ordered by what to do next. Today it buckets by "unread or not", so once a chat is opened it sinks into Ready and the view carries no signal.

## Scope rule

Only chats that plausibly matter now are listed. A chat is in scope when any of these hold:

- it is blocked on the user (approval, question, plan waiting);
- it failed or was interrupted, and it was updated within 30 days;
- it has a turn in flight;
- the model spoke last and the user never replied, and it was updated within 30 days;
- its worktree has uncommitted changes and it was updated within 14 days;
- it was updated within 7 days.

Everything else stays out of the view. A footer line says older chats live in Workspaces. Manual Settle still hides a chat; a chat whose linked pull request is merged or closed is settled automatically.

## Statuses and groups

`SessionActivityStatus` gains `plan`, `interrupted`, `reply` and `ship`; `ready` now means "recent". Groups, in order:

1. **Needs you** — approval, input, plan, failed, interrupted, reply, review (unread).
2. **Working** — live turns.
3. **To ship** — idle chats with uncommitted changes.
4. **Recent** — everything else in scope.
5. **Settled** — collapsed.

Filter keys are `all`, `attention`, `working`, `ship`, `ready` and `settled`; `attention` maps to group 1 and each other key to one group.

## Signals

- **Reply digest** (`lib/activityDigest.ts`): from a transcript, whether the last chat message is the model's, plus a short snippet (the last sentence, preferring a question). Kept in localStorage per chat, capped at 200 entries, so it survives restarts. An entry older than the chat's `updatedAt` is ignored.
- **Ship signal** (`hooks/useActivityShipSignals.ts`): polls `gitDiffStat(cwd, 'uncommitted')` for at most 12 in-scope idle chats with a cwd, once a minute, only while the Activity view is visible. One result per cwd, attributed to the most recently updated chat in that cwd.
- **Reason line** (`lib/activityReason.ts`): one short string per row from the status and the signals — the pending command, the question asked, the plan state, the interrupt reason, the model's last sentence, the current tool, or the diff stat.

## Row

Activity rows are two lines: title and time on the first line, the reason line in muted text on the second. The left indicator stays: spinner for working, amber dot for anything in Needs you, accent dot for unread, red for failed. The attention pill is dropped in this view because the reason line carries it. Hover shows the existing "…" menu plus a Settle check for rows that can be settled.

## Files

- `src/lib/sidebarActivity.ts` — status derivation and scope rule
- `src/lib/activityDigest.ts`, `src/lib/activityReason.ts` — new
- `src/hooks/useActivityDigests.ts`, `src/hooks/useActivityShipSignals.ts` — new
- `src/hooks/useSidebarActivity.ts`, `src/components/SidebarActivity.tsx`, `src/components/SidebarSessionRow.tsx`, `src/components/Sidebar.tsx` — wiring and the two-line row

Existing tests in `src/lib/sidebarActivity.test.ts` are updated for the new statuses; no new test files.
