import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { ReasoningEffort, ServerEvent, SessionSummary, TranscriptEvent } from '../protocol.js';
import { readWorkspaceDiff } from './diff.js';
import {
  RemoteError, record, text, uuid,
  type RemoteEvent, type RemoteModel, type RemoteRuntime, type RemoteSelection, type RemoteSession,
} from './types.js';

const EFFORTS = new Set(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'dynamic']);
const MAX_SESSIONS = 6;
const MAX_TRANSCRIPT_CHARS = 96_000;

interface OwnedSession {
  view: RemoteSession;
  backendId?: string;
  clientRef: string;
  busy: boolean;
  stopRequested: boolean;
  hidden: boolean;
  seen: Set<string>;
  requests: Map<string, string>;
  approvalRequestId?: string;
  questionRequestId?: string;
  confirmed?: SessionSummary;
  creating: boolean;
}

export class RemoteHost {
  models: RemoteModel[] = [];
  private readonly sessions = new Map<string, OwnedSession>();
  private active = true;

  constructor(
    readonly workspace: string,
    private readonly runtime: RemoteRuntime,
    private readonly publish: (event: RemoteEvent) => void,
    private readonly diff = readWorkspaceDiff,
  ) {}

  get hasPendingCreates(): boolean {
    return [...this.sessions.values()].some((row) => row.creating);
  }

  snapshot(): RemoteSession[] {
    return [...this.sessions.values()].filter((row) => !row.hidden).map((row) => structuredClone(row.view));
  }

  async refreshCatalog(): Promise<void> {
    this.requireActive();
    await this.runtime.handle({ type: 'catalog.models' });
  }

  observe(event: ServerEvent): void {
    if (event.type === 'catalog.updated' && event.catalog === 'models') {
      this.models = event.items.flatMap((item): RemoteModel[] => {
        if (!item || typeof item !== 'object') return [];
        const model = item as Record<string, unknown>;
        if (typeof model.id !== 'string' || typeof model.displayName !== 'string') return [];
        const efforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.filter((effort): effort is ReasoningEffort => typeof effort === 'string' && EFFORTS.has(effort)) : [];
        const result: RemoteModel = { id: model.id, name: model.displayName, efforts };
        if (efforts.includes(model.defaultReasoningEffort as ReasoningEffort)) result.defaultEffort = model.defaultReasoningEffort as ReasoningEffort;
        return [result];
      });
      if (this.active) this.publish({ type: 'catalog', models: this.models });
      return;
    }
    if (event.type === 'session.created') {
      const row = [...this.sessions.values()].find((candidate) => candidate.clientRef === event.clientRef);
      if (!row) return;
      row.creating = false;
      row.backendId = event.session.appSessionId;
      row.confirmed = event.session;
      if (!this.active || row.hidden || row.stopRequested) {
        void this.runtime.handle({ type: 'session.close', appSessionId: row.backendId }).then(() => {
          row.busy = false;
        }, () => {
          console.error('Could not close a cancelled mobile session. Check the computer.');
          this.fail(row, 'Could not close the cancelled session. Check the computer.');
        });
      }
      return;
    }
    if (event.type === 'error' && event.clientRef) {
      const row = [...this.sessions.values()].find((candidate) => candidate.clientRef === event.clientRef);
      if (row) {
        row.creating = false;
        if (this.active && !row.hidden) this.fail(row, event.message);
      }
      return;
    }
    const backendId = event.type === 'event.appended' ? event.event.appSessionId
      : event.type === 'session.updated' ? event.session.appSessionId
      : event.type === 'approval.requested' ? event.request.appSessionId
      : event.type === 'question.requested' ? event.question.appSessionId
      : 'appSessionId' in event ? event.appSessionId : undefined;
    const row = [...this.sessions.values()].find((candidate) => candidate.backendId && candidate.backendId === backendId);
    if (!row || !this.active || row.hidden) return;
    if (event.type === 'session.updated') {
      const wasStreaming = row.confirmed?.streaming === true;
      row.confirmed = event.session;
      if (!event.session.streaming && wasStreaming) row.busy = false;
      if (row.stopRequested) return;
      if (event.session.phase === 'failed' || (!event.session.streaming && event.session.phase === 'completed')) {
        delete row.view.approval;
        delete row.view.question;
        delete row.approvalRequestId;
        delete row.questionRequestId;
      }
      if (event.session.phase === 'failed') this.fail(row, event.session.interruptReason || 'The desktop agent failed. Check DROIDEX on your computer.');
      else if (event.session.streaming) {
        if (!row.view.approval && !row.view.question) row.view.phase = 'running';
        this.changed(row);
      } else if (wasStreaming && row.view.phase !== 'failed') {
        void this.settle(row, row.view.runId).catch(() => this.fail(row, 'Could not finish the workspace review.'));
      }
      return;
    }
    if (row.stopRequested) return;
    switch (event.type) {
      case 'event.appended':
        if (row.busy && row.view.phase !== 'failed') this.append(row, event.event);
        break;
      case 'approval.requested':
        row.approvalRequestId = event.request.requestId;
        row.view.approval = { id: randomUUID(), title: event.request.title, detail: (event.request.plan || event.request.detail).slice(0, 64_000) };
        row.view.phase = 'approval';
        this.changed(row);
        break;
      case 'question.requested':
        row.questionRequestId = event.question.requestId;
        row.view.question = { id: randomUUID(), questions: event.question.questions };
        row.view.phase = 'question';
        this.changed(row);
        break;
      case 'error': this.fail(row, event.message); break;
      case 'session.closed': row.busy = false; row.view.phase = 'stopped'; this.changed(row); break;
    }
  }

  turn(value: unknown): void {
    this.requireActive();
    const body = record(value);
    const id = uuid(body.id);
    const requestId = uuid(body.requestId);
    const prompt = text(body.prompt, 'Message');
    const selection = this.selection(body);
    const signature = createHash('sha256').update(JSON.stringify({ prompt, ...selection })).digest('hex');
    let row = this.sessions.get(id);
    if (row?.requests.has(requestId)) {
      if (row.requests.get(requestId) !== signature) throw new RemoteError(409, 'That request ID has already been used for a different message.');
      return;
    }
    if (row && (row.hidden || row.busy)) throw new RemoteError(409, 'This session is still working or is no longer available.');
    if (!row) {
      if (this.sessions.size >= MAX_SESSIONS) throw new RemoteError(409, 'This test connection has reached its session limit. Disable and pair again to start a new connection.');
      row = {
        view: { id, runId: randomUUID(), revision: 0, title: prompt.slice(0, 60), workspace: basename(this.workspace), ...selection, phase: 'running', messages: [], changes: [], diffNote: '', updatedAt: Date.now() },
        clientRef: `mobile:${randomUUID()}`, busy: false, creating: false, stopRequested: false, hidden: false, seen: new Set(), requests: new Map(),
      };
      this.sessions.set(id, row);
    }
    if (row.view.messages.reduce((size, message) => size + message.text.length, prompt.length) > MAX_TRANSCRIPT_CHARS) throw new RemoteError(409, 'Start a new session. This conversation reached its mobile transcript limit.');
    if (row.view.messages.length >= 100) throw new RemoteError(409, 'Start a new session. This MVP keeps up to 50 turns per session.');
    row.requests.set(requestId, signature);
    if (row.requests.size > 64) row.requests.delete(row.requests.keys().next().value as string);
    row.busy = true;
    row.stopRequested = false;
    row.seen.clear();
    row.view.runId = randomUUID();
    row.view.phase = 'running';
    row.view.changes = [];
    row.view.diffNote = '';
    delete row.view.error;
    delete row.view.approval;
    delete row.view.question;
    row.view.messages.push(
      { id: randomUUID(), role: 'user', text: prompt, steps: [] },
      { id: randomUUID(), role: 'assistant', text: '', steps: [] },
    );
    this.changed(row);
    void this.drive(row, prompt, selection);
  }

  private async drive(row: OwnedSession, prompt: string, selection: RemoteSelection): Promise<void> {
    const runId = row.view.runId;
    try {
      if (!row.backendId) {
        row.creating = true;
        await this.runtime.handle({
          type: 'session.create', clientRef: row.clientRef, cwd: this.workspace, title: row.view.title,
          goal: prompt, sessionPurpose: 'chat', interactionMode: selection.mode,
          modelId: selection.modelId, ...(selection.effort ? { reasoningEffort: selection.effort } : {}), autonomy: 'off',
        });
        row.creating = false;
        // Creation launches its first turn in the background. Settlement is observed below.
        if (this.current(row, runId) && !row.backendId && row.view.phase !== 'failed') this.fail(row, 'The desktop did not create this session. Check provider login on your computer.');
        return;
      }
      await this.runtime.handle({
        type: 'session.updateSettings', appSessionId: row.backendId, modelId: selection.modelId,
        ...(selection.effort ? { reasoningEffort: selection.effort } : {}), interactionMode: selection.mode, autonomy: 'off',
      });
      if (!this.current(row, runId) || row.view.phase === 'failed') return;
      if (row.confirmed?.modelId !== selection.modelId || row.confirmed.interactionMode !== selection.mode || (selection.effort && row.confirmed.reasoningEffort !== selection.effort)) {
        throw new Error('The desktop did not confirm the requested model and effort. No message was sent.');
      }
      delete row.view.effort;
      Object.assign(row.view, selection);
      await this.runtime.handle({ type: 'session.send', appSessionId: row.backendId, text: prompt });
      if (this.current(row, runId) && row.view.phase !== 'failed') await this.settle(row, runId);
    } catch (error) {
      row.creating = false;
      if (this.current(row, runId)) this.fail(row, error instanceof Error ? error.message : 'The desktop request failed.');
    } finally {
      // First-turn completion is owned by the streaming->idle transition, not create().
      if (this.current(row, runId) && row.view.phase === 'failed' && !row.confirmed?.streaming) row.busy = false;
    }
  }

  async interrupt(id: string): Promise<void> {
    const row = this.owned(id);
    row.stopRequested = true;
    delete row.view.approval;
    delete row.view.question;
    row.view.phase = 'stopped';
    this.changed(row);
    if (row.backendId) {
      try {
        await this.runtime.handle({ type: 'session.interrupt', appSessionId: row.backendId });
      } catch (error) {
        this.fail(row, 'Stop could not be confirmed. Check the session on your computer.');
        throw error;
      }
    }
    // A pending create stays busy until its late runtime has been closed.
    if (row.backendId) row.busy = false;
  }

  async approve(id: string, value: unknown): Promise<void> {
    const row = this.owned(id);
    const body = record(value);
    if (!row.backendId || !row.approvalRequestId || body.id !== row.view.approval?.id || typeof body.allow !== 'boolean') {
      throw new RemoteError(409, 'This approval is no longer pending.');
    }
    const requestId = row.approvalRequestId;
    delete row.approvalRequestId;
    delete row.view.approval;
    row.view.phase = 'running';
    this.changed(row);
    try {
      await this.runtime.handle({ type: 'approval.respond', appSessionId: row.backendId, requestId, outcome: body.allow ? 'proceed_once' : 'cancel' });
    } catch (error) {
      this.fail(row, 'The approval could not be confirmed. Check the pending action on your computer.');
      throw error;
    }
  }

  async answer(id: string, value: unknown): Promise<void> {
    const row = this.owned(id);
    const body = record(value);
    if (!row.backendId || !row.questionRequestId || body.id !== row.view.question?.id || !Array.isArray(body.answers)) throw new RemoteError(409, 'This question is no longer pending.');
    const questions = row.view.question?.questions || [];
    if (body.answers.length !== questions.length) throw new RemoteError(400, 'Answer each question.');
    const supplied = body.answers;
    const answers = questions.map((question, index) => ({ index: question.index, question: question.question, answer: text(supplied[index], 'Answer', 4_000) }));
    const requestId = row.questionRequestId;
    delete row.questionRequestId;
    delete row.view.question;
    row.view.phase = 'running';
    this.changed(row);
    try {
      await this.runtime.handle({ type: 'question.respond', appSessionId: row.backendId, requestId, cancelled: false, answers });
    } catch (error) {
      this.fail(row, 'The answer could not be confirmed. Check the question on your computer.');
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const row = this.owned(id);
    row.hidden = true;
    row.stopRequested = true;
    this.publish({ type: 'removed', id: row.view.id });
    if (row.backendId) await this.runtime.handle({ type: 'session.close', appSessionId: row.backendId });
  }

  async close(): Promise<void> {
    this.active = false;
    const results = await Promise.allSettled([...this.sessions.values()].flatMap((row) => {
      row.stopRequested = true;
      return row.backendId ? [this.runtime.handle({ type: 'session.close', appSessionId: row.backendId })] : [];
    }));
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Phone access was revoked, but some desktop sessions could not be closed. Stop them in DROIDEX on the computer.');
    }
  }

  private append(row: OwnedSession, event: TranscriptEvent): void {
    if (event.role !== 'primary' || event.author === 'user' || row.seen.has(event.id)) return;
    row.seen.add(event.id);
    const message = row.view.messages.at(-1);
    if (!message || message.role !== 'assistant') return;
    if (event.kind === 'text') message.text += event.text || '';
    else if (event.kind === 'tool_call') message.steps.push(event.toolName || 'Running a tool');
    else if (event.kind === 'thinking' && message.steps.at(-1) !== 'Thinking') message.steps.push('Thinking');
    else if (event.kind === 'error') message.steps.push((event.text || 'A tool reported an error').slice(0, 300));
    if (row.view.messages.reduce((size, item) => size + item.text.length, 0) > MAX_TRANSCRIPT_CHARS || row.seen.size > 8_000) {
      message.text = message.text.slice(0, MAX_TRANSCRIPT_CHARS);
      void this.interrupt(row.view.id).catch(() => console.error('Mobile transcript limit: stop could not be confirmed.'));
      this.fail(row, 'This turn reached the mobile preview limit. Continue reviewing it on your computer.');
      return;
    }
    if (message.steps.length > 100) message.steps.splice(0, message.steps.length - 100);
    this.changed(row);
  }

  private selection(body: Record<string, unknown>): RemoteSelection {
    const model = this.models.find((option) => option.id === body.modelId);
    if (!model) throw new RemoteError(400, 'Choose a model from this computer’s current catalog.');
    if (body.mode !== 'auto' && body.mode !== 'spec') throw new RemoteError(400, 'Choose Build or Plan.');
    const selection: RemoteSelection = { modelId: model.id, mode: body.mode };
    if (model.efforts.length) {
      if (!model.efforts.includes(body.effort as ReasoningEffort)) throw new RemoteError(400, 'Choose an effort supported by this model.');
      selection.effort = body.effort as ReasoningEffort;
    } else if (body.effort !== undefined && body.effort !== null) throw new RemoteError(400, 'This model does not expose reasoning controls.');
    return selection;
  }

  private owned(id: string): OwnedSession {
    this.requireActive();
    const row = this.sessions.get(uuid(id));
    if (!row || row.hidden) throw new RemoteError(404, 'Session not found on this connection.');
    return row;
  }

  private requireActive(): void { if (!this.active) throw new RemoteError(410, 'This computer connection has been disabled. Pair again.'); }
  private current(row: OwnedSession, runId: string): boolean { return this.active && !row.hidden && !row.stopRequested && row.view.runId === runId; }
  private changed(row: OwnedSession): void {
    row.view.revision += 1;
    row.view.updatedAt = Date.now();
    if (this.active && !row.hidden) this.publish({ type: 'session', session: structuredClone(row.view) });
  }
  private fail(row: OwnedSession, message: string): void {
    row.view.phase = 'failed';
    row.view.error = message.slice(0, 2_000);
    row.busy = row.confirmed?.streaming === true;
    if (row.busy && row.backendId) {
      void this.runtime.handle({ type: 'session.interrupt', appSessionId: row.backendId }).catch(() => {
        console.error('Could not interrupt a failed mobile turn. Check the desktop session.');
      });
    }
    this.changed(row);
  }

  private async settle(row: OwnedSession, runId: string): Promise<void> {
    if (!this.current(row, runId) || row.view.approval || row.view.question || row.view.phase === 'completed') return;
    row.view.phase = 'completed';
    row.busy = false;
    this.changed(row);
    const result = await this.diff(this.workspace);
    if (!this.current(row, runId)) return;
    row.view.changes = result.changes;
    row.view.diffNote = result.note;
    this.changed(row);
  }
}
