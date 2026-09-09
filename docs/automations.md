# Automations

Open **Automations** in the sidebar to create a scheduled task, edit its
instructions, pause it, or run it now. Choose a workspace, model, reasoning
level, autonomy, schedule, and timezone. One-time schedules require a future
date; recurring schedules support hourly, daily, weekdays, weekly, and five-field
cron expressions.

You can also ask in chat. The automation proposal card lets you review and edit
the details before confirming. Direct creation requires a High-autonomy chat;
unattended automation runs cannot create more automations.

DROIDEX must be running for scheduled tasks to execute. Runs are queued and
executed one at a time. An automation cannot stack another open run. Three
consecutive failed runs pause its schedule; inspect the error, fix the cause,
and turn it back on.

Local execution uses the selected folder. Worktree execution creates an isolated
Git worktree. Completed runs retain their chat and worktree for review; closing
the review chat triggers cleanup. Inspect cleanup errors before removing files.

## Implementation

The sidecar automation manager serializes persistence. The catalog owns task
definitions, the scheduler owns wake timing, and the run queue owns session and
worktree lifecycles. The renderer consumes validated bridge snapshots and sends
typed commands. Mutations fail while disconnected rather than being replayed
from an offline queue.

Proposal results use JSON from the automation tools, either directly or inside
MCP text content. The renderer does not recover proposal IDs from malformed JSON,
Markdown fences, or unrelated nested fields. Tool errors appear on the card.
