// One Claude Code process per DROIDEX session, driven through the agent SDK's
// streaming-input mode: the prompt is a live async iterable, so turns reuse the
// same process and the permission mode and model can change while it runs.
import {
  query,
  type EffortLevel,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { NormalizedEvent } from '../../normalize.js';
import type { Autonomy, ReasoningEffort, SessionInteractionMode } from '../../protocol.js';
import { errMsg } from '../../sessionHelpers.js';
import type { ProviderInteractions } from '../interactions.js';
import type { ProviderModelSettings, ProviderSession } from '../session.js';
import { ClaudeEventMapper, rateLimitRefusal } from './claudeEvents.js';
import { claudeCanUseTool, claudePermissionMode } from './claudePermissions.js';

// Booting the CLI takes seconds, and the first turn streams while it happens, so
// the chat says what it is waiting for instead of sitting empty.
const STARTING = 'Starting Claude Code…';

export interface ClaudeSessionInput {
  // Claude pins the session id it is given, so DROIDEX's own identity is also
  // the provider's: there is no separate resume handle.
  appSessionId: string;
  executable: string;
  cwd: string;
  autonomy: Autonomy;
  interactionMode: SessionInteractionMode;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  mcpServers: Record<string, McpServerConfig>;
  interactions: ProviderInteractions;
  // Set when reopening a stored session instead of starting a new one.
  resume?: boolean;
}

export class ClaudeSession implements ProviderSession {
  readonly provider = 'claude' as const;
  readonly providerSessionId: string;
  readonly closed: Promise<Error | undefined>;

  private readonly abort = new AbortController();
  private resolveClosed: (error?: Error) => void = () => undefined;
  private initializationError?: Error;
  private readonly prompts = new PromptQueue();
  private readonly mapper: ClaudeEventMapper;
  private readonly query: Query;
  // Settles when the CLI has finished booting. Turns stream against a CLI that
  // is still coming up; control requests wait for it, because the SDK writes
  // them to stdin the moment they are made and the CLI has not answered its own
  // `initialize` yet (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs,
  // Query.request: no queue, no gate).
  private readonly initialized: Promise<void>;
  // Resolves once the CLI process exists, which is all an open has to wait for.
  private readonly spawned: Promise<void>;
  private initializing = true;
  private child?: ChildProcess;
  private autonomy: Autonomy;
  // Spec mode is Claude Code's plan mode, and both reach the CLI as the one
  // permission mode, so the session owns which of the two is in force.
  private planning: boolean;
  // Serializes the permission-mode changes below, so two never race.
  private modeChanges: Promise<void> = Promise.resolve();
  private activeTurnId?: string;
  // The turn the user stopped, so only that turn's own error result is excused.
  private interruptedTurnId?: string;

  constructor(input: ClaudeSessionInput) {
    this.providerSessionId = input.appSessionId;
    this.autonomy = input.autonomy;
    this.planning = input.interactionMode === 'spec';
    this.mapper = new ClaudeEventMapper(input.appSessionId);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    let markSpawned = (): void => undefined;
    let rejectSpawn = (error: Error): void => {
      void error;
    };
    const spawned = new Promise<void>((resolve, reject) => {
      markSpawned = resolve;
      rejectSpawn = reject;
    });
    this.query = query({
      prompt: this.prompts,
      options: sessionOptions(
        input,
        this.abort,
        () => this.planning,
        (process) => {
          this.child = process;
          process.once('spawn', markSpawned);
          process.once('error', rejectSpawn);
        },
      ),
    });
    this.initialized = this.query.initializationResult().then(
      () => {
        this.abort.signal.throwIfAborted();
        this.initializing = false;
      },
      (error: unknown) => {
        this.abort.signal.throwIfAborted();
        this.initializing = false;
        const failure = new Error(errMsg(error));
        this.initializationError = failure;
        this.finish(failure);
        throw failure;
      },
    );
    // Startup can fail before a turn observes it. The turn or the lifecycle's
    // closure observer reports the failure without an unhandled rejection.
    void this.initialized.catch(() => undefined);
    // A CLI that fails before it reaches spawn still settles initialization,
    // which is what releases the open instead of leaving it hanging.
    this.spawned = Promise.race([spawned, this.initialized]);
  }

  // Returns as soon as the CLI process exists, so the session reaches the
  // lifecycle with a pid to track while the CLI is still booting behind it.
  async start(): Promise<void> {
    await this.spawned;
  }

  get process(): { pid: number; isAlive(): boolean } | undefined {
    const child = this.child;
    const pid = child?.pid;
    if (child === undefined || pid === undefined) return undefined;
    return { pid, isAlive: () => child.exitCode === null && !child.killed };
  }

  async *stream(prompt: string): AsyncGenerator<NormalizedEvent, void, undefined> {
    if (this.activeTurnId) throw new Error('This Claude session is already running a turn.');
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    try {
      this.requireOpen();
      this.prompts.push({
        type: 'user',
        uuid: turnId,
        session_id: this.providerSessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: prompt },
      });
      // Only ever the first turn: by the second the CLI is up and its startup
      // is not what the chat is waiting for.
      if (this.initializing) yield this.mapper.statusEvent(STARTING);
      // Pulled one message at a time rather than with `for await`: leaving a
      // `for await` calls return() on the query, which would end the whole
      // session at the first turn that settles.
      for (;;) {
        const next = await this.nextMessage();
        // The CLI exited without answering. Failing here is what tells the
        // session the turn broke, instead of reading as a silent success.
        if (next.done) throw new Error('Claude Code exited before the turn finished.');
        for (const event of this.mapper.map(next.value)) yield event;
        // A refused usage window is answered with no result at all, so the turn
        // has to end here instead of waiting for one that never comes.
        if (next.value.type === 'rate_limit_event') {
          const refusal = rateLimitRefusal(next.value.rate_limit_info);
          if (refusal) throw new Error(refusal);
        }
        if (next.value.type === 'result' && answersTurn(next.value, turnId)) {
          // A stopped turn settles quietly: the CLI still reports the
          // interruption as an error result carrying an internal diagnostic.
          if (next.value.subtype !== 'success' && this.interruptedTurnId !== turnId)
            throw new Error(turnFailure(next.value.subtype, next.value.errors));
          yield { done: true };
          return;
        }
      }
    } finally {
      this.activeTurnId = undefined;
      this.initializationError = undefined;
    }
  }

  // The failure survives a delayed first prompt, even after the query closes.
  private async nextMessage(): Promise<IteratorResult<SDKMessage>> {
    this.requireOpen();
    const next = this.query.next();
    // Observe both promises even when closing the query settles its iterator first.
    if (this.initializing) await Promise.race([this.initialized, next]);
    const message = await next;
    this.requireOpen();
    return message;
  }

  async setAutonomy(autonomy: Autonomy): Promise<void> {
    await this.changePermissionMode(() => ({ autonomy, planning: this.planning }));
  }

  // Spec mode is plan mode: the model plans and reads, and its ExitPlanMode call
  // raises the plan for review rather than ending the mode itself.
  async setInteractionMode(mode: SessionInteractionMode): Promise<void> {
    await this.changePermissionMode(() => ({ autonomy: this.autonomy, planning: mode === 'spec' }));
  }

  // Autonomy and Spec reach the CLI as the one permission mode, so changes run
  // one at a time and each reads the session as it is when its turn comes: two
  // that overlap can no longer send a mode built from state the other replaced.
  // The session commits only what the CLI accepted.
  private changePermissionMode(
    next: () => { autonomy: Autonomy; planning: boolean },
  ): Promise<void> {
    const applied = this.modeChanges.then(async () => {
      await this.waitUntilInitialized();
      const { autonomy, planning } = next();
      // While the session is planning the permission mode is already plan mode
      // and stays it, so a new autonomy is only recorded here and takes effect
      // when the session leaves Spec.
      if (!planning || !this.planning)
        await this.query.setPermissionMode(planning ? 'plan' : claudePermissionMode(autonomy));
      this.abort.signal.throwIfAborted();
      this.autonomy = autonomy;
      this.planning = planning;
    });
    // A refused change settles its own caller; the next one still gets its turn.
    this.modeChanges = applied.catch(() => undefined);
    return applied;
  }

  // A null model is "back to the provider's own default", which is what an
  // absent model is. The effort rides the same call because the picker changes
  // both together; the CLI keeps it for the session without writing it to the
  // user's settings files.
  async setModel({ modelId, reasoningEffort }: ProviderModelSettings): Promise<void> {
    await this.waitUntilInitialized();
    if (modelId !== undefined) await this.query.setModel(modelId ?? undefined);
    this.abort.signal.throwIfAborted();
    const effort = claudeEffort(reasoningEffort);
    if (effort) await this.query.applyFlagSettings({ effortLevel: effort });
  }

  private requireOpen(): void {
    if (this.initializationError) throw this.initializationError;
    this.abort.signal.throwIfAborted();
  }

  private async waitUntilInitialized(): Promise<void> {
    this.requireOpen();
    await this.initialized;
    this.requireOpen();
  }

  async interrupt(): Promise<void> {
    this.interruptedTurnId = this.activeTurnId;
    // There is no initialized control channel to interrupt yet. Closing also
    // releases initialization waiters and prevents a late startup from reviving it.
    if (this.initializing || this.abort.signal.aborted) {
      await this.close();
      return;
    }
    // Aborts the in-flight turn on the live process; the turn then settles with
    // its own result, so the next prompt does not pay for a restart.
    await this.query.interrupt();
  }

  close(): Promise<void> {
    this.finish();
    return Promise.resolve();
  }

  private finish(error?: Error): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.prompts.close();
    // The SDK closes stdin and escalates SIGTERM to SIGKILL itself.
    this.query.close();
    this.resolveClosed(error);
  }
}

function sessionOptions(
  input: ClaudeSessionInput,
  abortController: AbortController,
  isPlanning: () => boolean,
  onSpawn: (process: ChildProcess) => void,
): Options {
  const effort = claudeEffort(input.reasoningEffort);
  return {
    abortController,
    cwd: input.cwd,
    pathToClaudeCodeExecutable: input.executable,
    ...(input.modelId ? { model: input.modelId } : {}),
    ...(effort ? { effort } : {}),
    ...(input.resume ? { resume: input.appSessionId } : { sessionId: input.appSessionId }),
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    // 'project' is what loads the repository's CLAUDE.md.
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    mcpServers: input.mcpServers,
    // The Spec toggle owns plan mode, so the model may not enter it on its own:
    // at high autonomy bypassPermissions skips canUseTool altogether and a
    // refusal there would never run. ExitPlanMode stays available because it is
    // how the model hands its plan over, and plan mode always asks the callback.
    disallowedTools: ['EnterPlanMode'],
    permissionMode:
      input.interactionMode === 'spec' ? 'plan' : claudePermissionMode(input.autonomy),
    // Consent to the bypass mode, not the mode itself: the CLI reads this flag
    // only as "this host may use bypassPermissions" and takes the mode from
    // permissionMode. Raising autonomy to high mid-session switches the mode
    // with setPermissionMode, which the CLI refuses without this.
    allowDangerouslySkipPermissions: true,
    canUseTool: claudeCanUseTool(input.appSessionId, input.interactions, isPlanning),
    // The SDK would otherwise own the subprocess privately; spawning it here is
    // what gives the session a pid for the agent-process monitor to track and
    // kill, the way it tracks Droid's.
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      const child = spawn(command, args, {
        ...(cwd !== undefined ? { cwd } : {}),
        env,
        signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // Nothing else reads stderr on this path, and a full pipe would stall the
      // CLI mid-turn.
      child.stderr.resume();
      onSpawn(child);
      return child;
    },
    // HOME is never overridden: on macOS it also relocates the login keychain,
    // and the CLI then reports the user as signed out.
  };
}

// DROIDEX's effort vocabulary is the union of every harness's; Claude Code
// takes the five levels it publishes and nothing else, so a level from another
// harness leaves the session on its own default rather than being coerced.
const CLAUDE_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function claudeEffort(effort: ReasoningEffort | undefined): EffortLevel | undefined {
  return CLAUDE_EFFORTS.find((level) => level === effort);
}

function turnFailure(subtype: string, errors: string[]): string {
  // The CLI's own diagnostics are bracketed internals; the subtype is what a
  // user can act on.
  const detail = errors.filter((error) => !error.startsWith('[')).join('\n');
  return detail
    ? `Claude Code ended the turn (${subtype}): ${detail}`
    : `Claude Code ended the turn (${subtype}).`;
}

function answersTurn(
  message: { user_message_uuid?: string; user_message_uuids?: string[] },
  turnId: string,
): boolean {
  // The plural list names every prompt the turn has consumed, so where it
  // exists it is the whole answer: a result that omits this turn's uuid belongs
  // to another turn, whatever the singular field says.
  if (message.user_message_uuids) return message.user_message_uuids.includes(turnId);
  if (message.user_message_uuid !== undefined) return message.user_message_uuid === turnId;
  // Older CLIs stamp neither field; their result can only be this turn's.
  return true;
}

// The session's prompt channel. One iterator, consumed by whichever turn is
// streaming, so the process stays warm between turns.
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private waiting?: (result: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  push(message: SDKUserMessage): void {
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: message, done: false });
      return;
    }
    this.queued.push(message);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        const queued = this.queued.shift();
        if (queued) return { value: queued, done: false };
        if (this.closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
