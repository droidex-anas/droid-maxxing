// One `codex app-server` process per DROIDEX session, holding one thread. Turns
// run on that thread; model, effort and autonomy ride on each `turn/start`,
// which Codex applies to that turn and the ones after it.
import type { NormalizedEvent } from '../../normalize.js';
import type { Autonomy } from '../../protocol.js';
import { errMsg } from '../../sessionHelpers.js';
import type { ProviderInteractions } from '../interactions.js';
import type { ProviderModelSettings, ProviderSession } from '../session.js';
import type { AppServerClient } from './appServer.js';
import { codexAutonomy, OpenPrompts } from './codexApprovals.js';
import {
  CodexEventMapper,
  errorOf,
  turnOf,
  MAPPED_NOTIFICATIONS,
  type CodexTurn,
} from './codexEvents.js';
import { CodexStartup } from './codexStartup.js';
import { TurnStream, turnStartParams } from './codexTurn.js';

export interface CodexSessionInput {
  // DROIDEX's own identity for the session. Codex mints its thread id itself,
  // which the session carries separately as its resume handle.
  appSessionId: string;
  client: AppServerClient;
  cwd: string;
  autonomy: Autonomy;
  model: ProviderModelSettings;
  interactions: ProviderInteractions;
}

interface ThreadResponse {
  thread: { id: string };
  // The model the thread actually resolved to, which is what a reset goes back to.
  model: string;
}

export class CodexSession implements ProviderSession {
  readonly provider = 'codex' as const;
  readonly providerSessionId: string;

  private readonly client: AppServerClient;
  private readonly mapper: CodexEventMapper;
  private readonly cwd: string;
  private autonomy: Autonomy;
  private model: ProviderModelSettings;
  private threadId?: string;
  private threadModel?: string;
  private turnId?: string;
  private turn?: TurnStream;
  // Stop pressed before `turn/start` answered: there is a turn to end but no id
  // to name it with yet.
  private pendingInterrupt = false;
  private readonly prompts: OpenPrompts;
  private readonly startup = new CodexStartup();
  // Codex reports its servers in one burst, so the notice is folded to the end
  // of the tick that carries it and the count is the burst's, not the first
  // frame's.
  private startupNoticePending = false;

  constructor(input: CodexSessionInput) {
    this.providerSessionId = input.appSessionId;
    this.client = input.client;
    this.cwd = input.cwd;
    this.autonomy = input.autonomy;
    this.model = input.model;
    this.mapper = new CodexEventMapper(input.appSessionId);
    this.prompts = new OpenPrompts(input.appSessionId, input.interactions);
    // Registered before `initialize`, so nothing the server sends can arrive
    // before its handler exists. Requests left unregistered — the legacy exec
    // and patch callbacks, additional permissions, MCP elicitation — are
    // answered with method-not-found by the transport, never granted.
    // `serverRequest/resolved` is not one of them: Codex sends it for the
    // requests this client itself just answered, so acting on it would cancel
    // live cards. It only matters when a second client shares the thread.
    this.registerHandlers();
  }

  // Codex owns its thread ids, so this is the handle a restart resumes from.
  get resumeId(): string | undefined {
    return this.threadId;
  }

  get process(): { pid: number; isAlive(): boolean } | undefined {
    const pid = this.client.pid;
    if (pid === undefined) return undefined;
    return { pid, isAlive: () => this.client.isAlive() };
  }

  // Opens the session's thread: a new one, or the stored one it is resuming.
  // A thread Codex cannot load is a visible failure; starting a fresh thread
  // under the same identity would silently lose the conversation.
  async open(resumeId?: string): Promise<void> {
    const { approvalPolicy, sandbox } = codexAutonomy(this.autonomy);
    const settings = {
      cwd: this.cwd,
      approvalPolicy,
      sandbox,
      ...(this.model.modelId ? { model: this.model.modelId } : {}),
    };
    const response = await (resumeId
      ? this.client.request<ThreadResponse>('thread/resume', {
          threadId: resumeId,
          // The stored transcript is DROIDEX's scrollback; Codex only has to
          // reload the thread's own history for the model.
          excludeTurns: true,
          ...settings,
        })
      : this.client.request<ThreadResponse>('thread/start', settings));
    this.threadId = response.thread.id;
    this.threadModel = response.model;
  }

  async *stream(prompt: string): AsyncGenerator<NormalizedEvent, void, undefined> {
    if (this.turn) throw new Error('This Codex session is already running a turn.');
    const threadId = this.threadId;
    if (!threadId) throw new Error('This Codex session has no thread to run a turn on.');
    const turn = new TurnStream();
    this.turn = turn;
    this.pendingInterrupt = false;
    try {
      // The thread's own startup may still be running behind this turn; what is
      // left of it is announced now rather than leaving the chat silent.
      this.announceStartup();
      const started = await this.client.request<{ turn: CodexTurn }>(
        'turn/start',
        turnStartParams(threadId, prompt, {
          autonomy: this.autonomy,
          model: this.model,
          ...(this.threadModel ? { threadModel: this.threadModel } : {}),
        }),
      );
      this.adoptTurn(started.turn.id);
      yield* turn.drain();
    } finally {
      // Releases a waiter left parked when the consumer stops reading early.
      turn.finish();
      this.turn = undefined;
      this.turnId = undefined;
      this.pendingInterrupt = false;
    }
  }

  // Both ride on the next `turn/start`, which is where Codex takes them.
  setAutonomy(autonomy: Autonomy): Promise<void> {
    this.autonomy = autonomy;
    return Promise.resolve();
  }

  setModel(settings: ProviderModelSettings): Promise<void> {
    // An omitted field keeps its value; only what the caller named changes.
    this.model = {
      ...this.model,
      ...(settings.modelId !== undefined ? { modelId: settings.modelId } : {}),
      ...(settings.reasoningEffort !== undefined
        ? { reasoningEffort: settings.reasoningEffort }
        : {}),
    };
    return Promise.resolve();
  }

  // Codex takes a prompt into the running turn instead of ending it. The turn
  // id is the server's own precondition, so a steer aimed at a turn that has
  // already settled is refused rather than applied to whatever runs now.
  async steer(text: string): Promise<void> {
    const threadId = this.threadId;
    const turnId = this.turnId;
    const turn = this.turn;
    if (!threadId || !turnId || !turn)
      throw new Error('This Codex session has no running turn to steer.');
    const steered = await this.client.request<{ turnId: string }>('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text }],
    });
    // A queued prompt may have started its own turn while this was in flight.
    // That turn owns its id, and Stop has to reach it rather than this one.
    if (this.turn === turn && this.turnId === turnId) this.turnId = steered.turnId;
  }

  async interrupt(): Promise<void> {
    // A stale pair would end a turn that already settled, or none at all.
    if (!this.threadId || !this.turn) return;
    if (!this.turnId) {
      this.pendingInterrupt = true;
      return;
    }
    await this.sendInterrupt(this.turnId);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private registerHandlers(): void {
    for (const method of MAPPED_NOTIFICATIONS) {
      this.client.onNotification(method, (params) => {
        // Every `item/` notification is the turn answering; the token-usage one
        // is accounting and says nothing about progress.
        if (method.startsWith('item/')) this.startup.itemArrived();
        this.turn?.push(this.mapper.map(method, params));
      });
    }
    this.client.onNotification('mcpServer/startupStatus/updated', (params) => {
      this.startup.serverStatus(params);
      this.announceStartup();
    });
    this.client.onNotification('hook/started', () => {
      this.startup.hookStarted();
      this.announceStartup();
    });
    this.client.onNotification('hook/completed', () => {
      this.startup.hookCompleted();
    });
    // Every payload is read through a guard: a notification this build does not
    // recognize must not throw out of the transport's stdout listener.
    this.client.onNotification('turn/started', (params) => {
      const turn = turnOf(params);
      if (turn) this.adoptTurn(turn.id);
    });
    this.client.onNotification('turn/completed', (params) => {
      const turn = turnOf(params);
      if (turn) this.settle(turn);
    });
    this.client.onNotification('error', (params) => {
      const failure = errorOf(params);
      if (!failure) return;
      this.turn?.push([this.mapper.errorEvent(failure.message)]);
      // A retrying error is a hiccup the turn recovers from on its own.
      if (!failure.willRetry) this.turn?.fail(new Error(failure.message));
    });
    this.client.onClose((error) => {
      this.turn?.fail(error);
      this.prompts.cancel();
    });
    this.prompts.register(this.client, (itemId: string) => this.mapper.toolDetail(itemId));
  }

  // The turn's id arrives either on `turn/started` or with the `turn/start`
  // response, whichever lands first; a Stop that beat both goes out now.
  private adoptTurn(turnId: string): void {
    this.turnId = turnId;
    if (!this.pendingInterrupt) return;
    this.pendingInterrupt = false;
    // Nobody is waiting on this one, so a refused stop is reported in the turn
    // it belongs to — never in whichever turn happens to be open by then.
    const turn = this.turn;
    void this.sendInterrupt(turnId).catch((error: unknown) => {
      if (this.turn === turn) turn?.push([this.mapper.errorEvent(errMsg(error))]);
    });
  }

  // Nothing to say outside a turn: there is no transcript for it to land in, and
  // holding the notice keeps it for the turn that is actually waiting.
  private announceStartup(): void {
    if (this.startupNoticePending || !this.turn) return;
    this.startupNoticePending = true;
    queueMicrotask(() => {
      this.startupNoticePending = false;
      // Reading the notices spends them, so the turn that receives them has to
      // still be there when the burst settles.
      const turn = this.turn;
      if (!turn) return;
      const notices = this.startup.notices();
      if (notices.length > 0) turn.push(notices.map((text) => this.mapper.statusEvent(text)));
    });
  }

  private sendInterrupt(turnId: string): Promise<unknown> {
    return this.client.request('turn/interrupt', { threadId: this.threadId, turnId });
  }

  private settle(turn: CodexTurn): void {
    this.prompts.cancel();
    if (turn.status === 'failed') {
      this.turn?.fail(new Error(turn.error?.message ?? 'Codex ended the turn with an error.'));
      return;
    }
    // An interrupted turn settles quietly; the user asked for it.
    if (turn.status === 'completed') this.turn?.push([{ done: true }]);
    this.turn?.finish();
  }
}
