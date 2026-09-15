import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ClientCommand, ServerEvent, SessionSummary } from '../protocol.js';
import { RemoteHost } from './host.js';
import type { RemoteRuntime } from './types.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const catalog = [
  { id: 'real-model', displayName: 'Installed model', isCustom: false, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
  { id: 'fast-model', displayName: 'Fast model', isCustom: true },
];

class Runtime implements RemoteRuntime {
  commands: ClientCommand[] = [];
  observe: (event: ServerEvent) => void = () => {};
  summary?: SessionSummary;
  createGate?: Promise<void>;
  settingsGate?: Promise<void>;
  confirmSettings = true;
  rejectCreate = false;
  private finishSend?: () => void;

  async handle(command: ClientCommand): Promise<void> {
    this.commands.push(command);
    switch (command.type) {
      case 'catalog.models': this.observe({ type: 'catalog.updated', catalog: 'models', items: catalog }); break;
      case 'session.create': {
        await this.createGate;
        if (this.rejectCreate) {
          this.observe({ type: 'error', clientRef: command.clientRef, message: 'Log in to Droid on the desktop.' });
          return;
        }
        this.summary = {
          appSessionId: randomUUID(), providerSessionId: randomUUID(), sessionPurpose: 'chat',
          role: 'user', title: command.title, goal: command.goal, cwd: command.cwd || '',
          modelId: command.modelId, reasoningEffort: command.reasoningEffort, interactionMode: command.interactionMode || 'auto',
          autonomy: command.autonomy, phase: 'intake', streaming: false, features: [],
          tokensIn: 0, tokensOut: 0, contextTokens: 0, createdAt: Date.now(), updatedAt: Date.now(),
        };
        this.observe({ type: 'session.created', clientRef: command.clientRef, session: { ...this.summary } });
        // Real lifecycle.create returns before its background first turn finishes.
        this.streaming(true);
        break;
      }
      case 'session.updateSettings':
        await this.settingsGate;
        if (this.summary && this.confirmSettings) {
          this.summary = { ...this.summary, modelId: command.modelId || undefined, reasoningEffort: command.reasoningEffort, interactionMode: command.interactionMode || 'auto' };
          this.observe({ type: 'session.updated', session: { ...this.summary } });
        }
        break;
      case 'session.send':
        this.streaming(true);
        await new Promise<void>((resolve) => { this.finishSend = resolve; });
        break;
      case 'session.interrupt':
      case 'session.close': this.finish(); break;
    }
  }

  streaming(value: boolean) {
    if (!this.summary) return;
    this.summary = { ...this.summary, streaming: value, phase: value ? 'running' : 'completed' };
    this.observe({ type: 'session.updated', session: { ...this.summary } });
  }
  output(text: string, id = randomUUID()) {
    assert.ok(this.summary);
    this.observe({ type: 'event.appended', event: {
      id, appSessionId: this.summary.appSessionId, sourceSessionId: this.summary.providerSessionId || '',
      role: 'primary', ts: Date.now(), kind: 'text', text,
    } });
  }
  finish() { this.streaming(false); this.finishSend?.(); this.finishSend = undefined; }
}

async function setup() {
  const runtime = new Runtime();
  const host = new RemoteHost('/chosen/workspace', runtime, () => {}, async () => ({ changes: [], note: 'Working tree' }));
  runtime.observe = (event) => host.observe(event);
  await host.refreshCatalog();
  const turn = { id: randomUUID(), requestId: randomUUID(), prompt: 'Inspect the workspace', modelId: 'real-model', effort: 'high', mode: 'auto' };
  return { host, runtime, turn };
}

test('catalog is real; create uses canonical runtime with explicit off autonomy and chosen cwd', async () => {
  const { host, runtime, turn } = await setup();
  host.turn(turn); await tick();
  const command = runtime.commands.find((item) => item.type === 'session.create');
  assert.equal(command?.autonomy, 'off');
  assert.equal(command?.cwd, '/chosen/workspace');
  assert.equal(command?.modelId, 'real-model');
  assert.equal(command?.reasoningEffort, 'high');
  assert.deepEqual(host.models[1]?.efforts, []);
  assert.equal(host.snapshot()[0]?.phase, 'running');
  runtime.output('A'); runtime.output('B'); runtime.finish(); await tick();
  assert.equal(host.snapshot()[0]?.messages.at(-1)?.text, 'AB');
  assert.equal(host.snapshot()[0]?.phase, 'completed');
  await host.close();
});

test('repeated request IDs never duplicate work; changed payloads and unsupported selections fail', async () => {
  const { host, runtime, turn } = await setup();
  host.turn(turn); host.turn(turn); await tick();
  assert.equal(runtime.commands.filter((item) => item.type === 'session.create').length, 1);
  assert.throws(() => host.turn({ ...turn, prompt: 'Different instruction' }), /already been used/);
  assert.throws(() => host.turn({ ...turn, id: randomUUID(), modelId: 'invented' }), /current catalog/);
  assert.throws(() => host.turn({ ...turn, id: randomUUID(), effort: 'ultra' }), /supported/);
  assert.throws(() => host.turn({ ...turn, id: randomUUID(), modelId: 'fast-model' }), /does not expose/);
  await host.close();
});

test('foreign and duplicate events cannot alter the mobile session; late output after stop is ignored', async () => {
  const { host, runtime, turn } = await setup();
  host.turn(turn); await tick();
  const eventId = randomUUID();
  runtime.output('Visible', eventId); runtime.output('Visible', eventId);
  runtime.observe({ type: 'error', appSessionId: randomUUID(), message: 'Unrelated failure' });
  assert.equal(host.snapshot()[0]?.phase, 'running');
  assert.equal(host.snapshot()[0]?.messages.at(-1)?.text, 'Visible');
  await host.interrupt(turn.id);
  runtime.output('Late text');
  assert.equal(host.snapshot()[0]?.phase, 'stopped');
  assert.equal(host.snapshot()[0]?.messages.at(-1)?.text, 'Visible');
  await host.close();
});

test('approvals are scoped, single use, and continue the real turn instead of faking completion', async () => {
  const { host, runtime, turn } = await setup();
  host.turn(turn); await tick();
  assert.ok(runtime.summary);
  runtime.observe({ type: 'approval.requested', request: {
    appSessionId: runtime.summary.appSessionId, requestId: 'provider-request', kind: 'exec', title: 'Run tests?', detail: 'npm test', raw: {},
  } });
  const approval = host.snapshot()[0]?.approval;
  assert.ok(approval);
  await assert.rejects(host.approve(turn.id, { id: randomUUID(), allow: true }), /no longer pending/);
  await host.approve(turn.id, { id: approval.id, allow: true });
  assert.ok(runtime.commands.some((item) => item.type === 'approval.respond' && item.outcome === 'proceed_once' && item.requestId === 'provider-request'));
  assert.equal(host.snapshot()[0]?.phase, 'running');
  await assert.rejects(host.approve(turn.id, { id: approval.id, allow: true }), /no longer pending/);
  runtime.output('Tests finished.'); runtime.finish(); await tick();
  assert.equal(host.snapshot()[0]?.phase, 'completed');
  await host.close();
});

test('questions preserve provider indexes and cannot be answered by a stale request', async () => {
  const { host, runtime, turn } = await setup();
  host.turn(turn); await tick(); assert.ok(runtime.summary);
  runtime.observe({ type: 'question.requested', question: { appSessionId: runtime.summary.appSessionId, requestId: 'question-key', questions: [{ index: 4, question: 'Which file?', options: ['a.swift', 'b.swift'] }] } });
  const question = host.snapshot()[0]?.question; assert.ok(question);
  await assert.rejects(host.answer(turn.id, { id: question.id, answers: [] }), /each question/);
  await host.answer(turn.id, { id: question.id, answers: ['a.swift'] });
  const command = runtime.commands.find((item) => item.type === 'question.respond');
  assert.deepEqual(command?.answers, [{ index: 4, question: 'Which file?', answer: 'a.swift' }]);
  await host.close();
});

test('revocation during creation closes the late provider and accepts no new work', async () => {
  const { host, runtime, turn } = await setup();
  let release!: () => void;
  runtime.createGate = new Promise<void>((resolve) => { release = resolve; });
  host.turn(turn);
  assert.equal(host.hasPendingCreates, true);
  await host.close(); release(); await tick();
  assert.ok(runtime.commands.some((item) => item.type === 'session.close'));
  assert.equal(host.hasPendingCreates, false);
  assert.throws(() => host.turn({ ...turn, id: randomUUID() }), /disabled/);
});

test('configuration must be confirmed before a follow-up; failed confirmation sends nothing', async () => {
  const { host, runtime, turn } = await setup();
  host.turn(turn); await tick(); runtime.finish(); await tick();
  runtime.confirmSettings = false;
  host.turn({ ...turn, requestId: randomUUID(), modelId: 'fast-model', effort: undefined }); await tick();
  assert.equal(host.snapshot()[0]?.phase, 'failed');
  assert.equal(runtime.commands.filter((item) => item.type === 'session.send').length, 0);
  await host.close();
});

test('follow-up settings do not release the busy guard before sending; no duplicated prompt', async () => {
  const { host, runtime, turn } = await setup();
  host.turn(turn); await tick(); runtime.finish(); await tick();
  let release!: () => void;
  runtime.settingsGate = new Promise<void>((resolve) => { release = resolve; });
  host.turn({ ...turn, requestId: randomUUID(), modelId: 'fast-model', effort: undefined });
  assert.throws(() => host.turn({ ...turn, requestId: randomUUID() }), /still working/);
  release(); await tick();
  assert.equal(runtime.commands.filter((item) => item.type === 'session.send').length, 1);
  runtime.finish(); await tick();
  assert.equal(host.snapshot()[0]?.modelId, 'fast-model');
  assert.equal(host.snapshot()[0]?.effort, undefined);
  await host.close();
});

test('provider login failures stay failures, never scripted output', async () => {
  const { host, runtime, turn } = await setup();
  runtime.rejectCreate = true;
  host.turn(turn); await tick();
  assert.equal(host.snapshot()[0]?.phase, 'failed');
  assert.match(host.snapshot()[0]?.error || '', /Log in/);
  assert.equal(host.snapshot()[0]?.messages.at(-1)?.text, '');
  await host.close();
});
