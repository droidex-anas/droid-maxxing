# Local Projects

Projects is a draft workspace for independent DROIDEX conversations. Its main
conversation and managed threads are normal top-level sessions, not harness
subagents. Each retains its own history, settings and runtime identity.

## Available in this draft

Open **Projects**, choose **Create project**, and select a harness, model,
reasoning level, autonomy and optional workspace. **New thread** on a card
starts a conversation owned by that thread. Cards identify their direct owner.
The main conversation can coordinate all members; other conversations can only
control their direct children. A child cannot exceed its owner's autonomy.

Opening a card uses the existing chat and composer: read history, send work,
change settings and inspect the conversation as usual. Opening or selecting a
thread does not stop its siblings. **Stop** remains available while automatic
coordination is paused. It interrupts that thread and cancels its queued work.

A settled managed turn reports only a bounded excerpt of its final primary
reply to its direct owner. Tool output and thinking never enter that report.
An owner receives an ordinary new turn when it becomes available; no model
polls or stays running to wait for another model. Ordinary user questions and
permission requests still require the human, not approval by another agent.

**Pause coordination** stops new automatic deliveries and launches, not turns
already handed to a provider. Resume permits another 20 automatic wakes. This
is a feedback-loop guard, not a token or monetary budget. Projects allows up
to eight threads per project, three levels of descendants, 32 projects and 64
queued/claimed messages per project. At most two Projects delivery turns run
at once; ordinary interactive sends keep their existing behavior.

Threads currently share their owner's workspace. Separate worktrees and
conflict resolution are not implemented; coordinate file ownership before
parallel edits. DROIDEX must remain running. It cannot wake a sleeping computer.

## Not implemented

**Agent-native thread tools are not connected.** The app bridge supports
creation, spawning, messaging, coordination questions, stopping and pausing,
but bridge commands are not tools automatically visible inside Factory,
Codex or Claude. This draft does not add an MCP server, register fictional
native tools, or claim autonomous thread spawning from a chat prompt.

Native provider tool transport, authenticated cross-harness end-to-end testing,
automatic worktree isolation and per-thread diff attribution remain outside
this draft. Review still uses the ordinary conversation/workspace facilities;
a shared checkout does not establish which agent authored each file change.

## Delivery and recovery

The project ledger is local `projects.json` under the DROIDEX user-data
directory. Writes use an atomic replacement and private file permissions.
Membership is persisted before a new session receives its first task.

The wake queue writes its claim before dispatch. **Accepted** means the
provider acknowledged the prompt, not that the model finished. The concurrency
slot stays held until that turn settles. Busy targets retain messages and
retry from lifecycle availability or runtime capacity events, not a timer.
Messages arriving during admission stay queued independently of that claim.

An unavailable or unacknowledged delivery pauses coordination with the claim
retained as uncertain. After restart, projects are paused. Open the indicated
conversations and review them before checking the acknowledgement and resuming;
that discards the uncertain claim **without resending it**. Automatic replay
could duplicate work and is deliberately forbidden.

Malformed or incompatible experimental ledgers fail visibly and are left
untouched. This draft provides no migration from earlier prototypes. Back up
any existing experimental `projects.json` before trying a changed draft.

## Ownership in code

`ProjectService` owns the graph and bounded reports. `ProjectActivity` retains
only a bounded final reply during an active managed turn. `ProjectWakeQueue`
owns claims, admission, cancellation and turn slots. `ProjectSessions`
correlates ordinary session creation and uses the existing scheduling receipt;
`SessionLifecycle` remains the only runtime owner. There is no second session
registry and no Projects SDK dependency.

The renderer has a feature-local snapshot, validated at the bridge boundary.
The card selector observes only displayed session fields, not token counts or
transcript arrays. The existing chat/composer is reused rather than reimplemented.
