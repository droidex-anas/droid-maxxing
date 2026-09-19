import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectService, type ProjectPort } from './ProjectService.js';
import type { ProjectPersistence } from './store.js';
import type { Project, ThreadInput } from './types.js';
import type { ServerEvent, SessionSummary } from '../protocol.js';

const input: ThreadInput = {
  title: 'Build',
  prompt: 'Build the feature.',
  provider: 'droid',
  autonomy: 'low',
  cwd: '/workspace',
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function drain() {
  for (let i = 0; i < 8; i += 1) await tick();
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function summary(id: string, selection: ThreadInput = input): SessionSummary {
  return {
    appSessionId: id,
    providerSessionId: id,
    provider: selection.provider,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'user',
    title: selection.title,
    goal: selection.prompt,
    cwd: selection.cwd ?? '',
    modelId: selection.modelId,
    reasoningEffort: selection.reasoningEffort,
    autonomy: selection.autonomy,
    phase: 'running',
    streaming: false,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function harness(saved: Project[] = []) {
  const sessions = new Map<string, SessionSummary>();
  const sent: { id: string; prompt: string }[] = [];
  const launched: ThreadInput[] = [];
  const events: ServerEvent[] = [];
  const state = {
    saved: structuredClone(saved),
    failSave: false,
    gate: undefined as Promise<void> | undefined,
    bindGate: undefined as Promise<void> | undefined,
  };
  let next = 0;
  const store: ProjectPersistence = {
    load: async () => structuredClone(state.saved),
    save: async (value) => {
      if (state.failSave) throw new Error('Disk full');
      state.saved = structuredClone(value);
    },
  };
  const port: ProjectPort = {
    get: (id) => sessions.get(id),
    create: async (selection, bind) => {
      const session = summary(`session-${++next}`, selection);
      sessions.set(session.appSessionId, session);
      if (state.bindGate) await state.bindGate;
      await bind(session);
      launched.push(selection);
      await streaming(session.appSessionId, true);
      return session;
    },
    deliver: async (id, prompt, isCurrent) => {
      if (state.gate) await state.gate;
      const session = sessions.get(id);
      if (!isCurrent() || !session || session.streaming)
        return { status: 'busy', retryOn: 'target' };
      sent.push({ id, prompt });
      await streaming(id, true);
      return { status: 'accepted', settled: Promise.resolve() };
    },
    interrupt: async (id) => {
      const session = sessions.get(id);
      if (session) session.phase = 'paused';
      await streaming(id, false);
    },
  };
  const projects = await ProjectService.open(port, store, (event) => events.push(event));
  async function streaming(id: string, value: boolean) {
    const session = sessions.get(id);
    assert.ok(session);
    session.streaming = value;
    await projects.observe({ type: 'session.updated', session: { ...session } });
  }
  async function finish(id: string, text = 'Done') {
    await projects.observe({
      type: 'event.appended',
      event: {
        id: `${id}-text`,
        appSessionId: id,
        sourceSessionId: id,
        role: 'primary',
        ts: 1,
        kind: 'text',
        text,
      },
    });
    await streaming(id, false);
  }
  async function root() {
    const id = await projects.create(input);
    const main = projects.list().find((project) => project.id === id)?.threads[0]?.appSessionId;
    assert.ok(main);
    await finish(main);
    return { id, main };
  }
  return {
    projects,
    sessions,
    sent,
    launched,
    events,
    state,
    store,
    port,
    streaming,
    finish,
    root,
  };
}

test('idle projects produce no turns; one completed child wakes its owner once', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { main } = await h.root();
  await drain();
  assert.equal(h.sent.length, 0);
  const child = await h.projects.spawn(main, {
    ...input,
    provider: 'codex',
    modelId: 'code',
    reasoningEffort: 'high',
  });
  await drain();
  assert.equal(h.sent.length, 0);
  await h.finish(child.appSessionId, 'Implemented the parser.');
  await drain();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.id, main);
  assert.match(h.sent[0]?.prompt ?? '', /Implemented the parser/);
  await h.streaming(child.appSessionId, false);
  await drain();
  assert.equal(h.sent.length, 1);
  assert.equal(h.launched[1]?.provider, 'codex');
  assert.equal(h.launched[1]?.modelId, 'code');
  assert.equal(h.launched[1]?.reasoningEffort, 'high');
  assert.equal(h.launched[1]?.cwd, '/workspace');
});

test('busy owners retain messages; sibling completions batch into one later turn', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { main } = await h.root();
  const a = await h.projects.spawn(main, input);
  const b = await h.projects.spawn(main, input);
  await h.streaming(main, true);
  await h.finish(a.appSessionId, 'A');
  await h.finish(b.appSessionId, 'B');
  await drain();
  assert.equal(h.sent.length, 0);
  assert.equal(h.projects.list()[0]?.queued, 2);
  await h.finish(main);
  await drain();
  assert.equal(h.sent.length, 1);
  assert.equal(h.projects.list()[0]?.queued, 0);
  assert.equal(h.projects.list()[0]?.wakesLeft, 19);
});

test('questions return immediately and suppress redundant child completion results', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { main } = await h.root();
  const child = await h.projects.spawn(main, input);
  await h.projects.ask(child.appSessionId, 'Which storage format?');
  await h.finish(child.appSessionId, 'Waiting.');
  await drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]?.prompt ?? '', /Which storage format/);
  assert.doesNotMatch(h.sent[0]?.prompt ?? '', /finished its turn/);
  await h.projects.send(main, child.appSessionId, 'Use JSON.');
  await drain();
  assert.equal(h.sent[1]?.id, child.appSessionId);
  assert.equal(h.projects.list()[0]?.threads[1]?.waiting, false);
});

test('ordinary chats adopt a project, with scoped ownership and no autonomy escalation', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  h.sessions.set('ordinary', summary('ordinary'));
  const child = await h.projects.spawn('ordinary', input);
  const grandchild = await h.projects.spawn(child.appSessionId, input);
  const other = await h.root();
  assert.equal(h.projects.list().length, 2);
  await assert.rejects(h.projects.send(child.appSessionId, 'ordinary', 'Take over'), /owner/);
  await assert.rejects(h.projects.send('ordinary', other.main, 'Cross project'), /outside/);
  await assert.rejects(
    h.projects.spawn(child.appSessionId, { ...input, autonomy: 'high' }),
    /autonomy/,
  );
  await h.projects.send('ordinary', grandchild.appSessionId, 'Main can coordinate all members.');
});

test('pause cancels a pending wake after asynchronous admission work', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { id, main } = await h.root();
  const child = await h.projects.spawn(main, input);
  const gate = deferred();
  h.state.gate = gate.promise;
  await h.finish(child.appSessionId);
  await tick();
  await h.projects.setPaused(id, true);
  gate.resolve();
  await drain();
  assert.equal(h.sent.length, 0);
  assert.equal(h.projects.list()[0]?.queued, 1);
  assert.equal(h.projects.list()[0]?.wakesLeft, 20);
});

test('stop waits for a cancelled claim before removing target messages', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { main } = await h.root();
  const child = await h.projects.spawn(main, input);
  const gate = deferred();
  h.state.gate = gate.promise;
  await h.projects.send(main, child.appSessionId, 'Do not deliver after stop.');
  await tick();
  const stopped = h.projects.stop(main, child.appSessionId);
  gate.resolve();
  await stopped;
  await drain();
  assert.equal(
    h.sent.some((item) => item.id === child.appSessionId),
    false,
  );
  assert.equal(
    h.state.saved[0]?.pending.some((item) => item.to === child.appSessionId),
    false,
  );
});

test('parallel spawn reservations cap fanout before provider creation', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { id, main } = await h.root();
  const gate = deferred();
  h.state.bindGate = gate.promise;
  const requests = Array.from({ length: 7 }, () => h.projects.spawn(main, input));
  await assert.rejects(h.projects.spawn(main, input), /eight/);
  await h.projects.setPaused(id, true);
  gate.resolve();
  const outcomes = await Promise.allSettled(requests);
  assert.ok(outcomes.every((result) => result.status === 'rejected'));
  assert.equal(h.launched.length, 1, 'no child goal reached the provider');
  assert.equal(h.projects.list()[0]?.launching, 0);
});

test('persistence failure fails closed without delivering a queued wake', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { main } = await h.root();
  const child = await h.projects.spawn(main, input);
  h.state.failSave = true;
  await assert.rejects(h.projects.send(main, child.appSessionId, 'Work'), /Disk full/);
  await drain();
  assert.equal(h.sent.length, 0);
  assert.equal(h.projects.list()[0]?.paused, true);
  assert.match(h.projects.list()[0]?.error ?? '', /Disk full/);
});

test('restart preserves an uncertain delivery and never replays it implicitly', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { id, main } = await h.root();
  const child = await h.projects.spawn(main, input);
  const gate = deferred();
  h.state.gate = gate.promise;
  await h.finish(child.appSessionId);
  await tick();
  const disk = structuredClone(h.state.saved);
  assert.equal(disk[0]?.delivery?.state, 'sending');
  const recovered = await harness(disk);
  t.after(() => recovered.projects.close());
  assert.equal(recovered.projects.list()[0]?.paused, true);
  assert.equal(recovered.projects.list()[0]?.uncertain, 1);
  await assert.rejects(recovered.projects.setPaused(id, false), /uncertain/);
  await recovered.projects.setPaused(id, false, true);
  await drain();
  assert.equal(recovered.sent.length, 0);
  assert.equal(recovered.projects.list()[0]?.uncertain, 0);
  h.projects.close();
  gate.resolve();
  await h.projects.flush();
});

test('automatic wake allowance bounds feedback without resetting on agent messages', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { main } = await h.root();
  const child = await h.projects.spawn(main, input);
  for (let i = 0; i < 21; i += 1) {
    await h.streaming(child.appSessionId, true);
    await h.finish(child.appSessionId, `Result ${i}`);
    await drain();
    await h.finish(main);
  }
  assert.equal(h.sent.length, 20);
  assert.equal(h.projects.list()[0]?.paused, true);
  assert.equal(h.projects.list()[0]?.wakesLeft, 0);
});

test('native permissions and user questions never generate controller turns', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  const { main } = await h.root();
  await h.projects.observe({
    type: 'approval.requested',
    request: {
      appSessionId: main,
      requestId: 'approval',
      kind: 'exec',
      title: 'Run?',
      detail: 'A command',
      raw: {},
    },
  });
  await h.projects.observe({
    type: 'question.requested',
    question: {
      appSessionId: main,
      requestId: 'question',
      questions: [{ index: 0, question: 'User decision?', options: [] }],
    },
  });
  await drain();
  assert.equal(h.sent.length, 0);
});

test('durable project request identity avoids a duplicate root', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  assert.equal(await h.projects.create(input, 'request-1'), 'request-1');
  assert.equal(await h.projects.create(input, 'request-1'), 'request-1');
  assert.equal(h.launched.length, 1);
});

test('project listing restores ordinary summaries without starting a provider', async (t) => {
  const h = await harness();
  t.after(() => h.projects.close());
  await h.root();
  const launched = h.launched.length;
  h.events.length = 0;
  h.projects.publish();
  assert.equal(h.launched.length, launched);
  assert.ok(h.events.some((event) => event.type === 'session.updated'));
  assert.equal(h.events.at(-1)?.type, 'projects.snapshot');
});
