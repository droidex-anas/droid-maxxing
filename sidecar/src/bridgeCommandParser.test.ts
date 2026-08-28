import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClientCommand } from './protocol.js';
import { parseBridgeCommand, MAX_BRIDGE_FRAME_BYTES } from './bridgeCommandParser.js';
import {
  MAX_BRIDGE_LIST_ITEMS,
  MAX_CHAT_TITLE_CHARS,
  MAX_HISTORY_PAGE_EVENTS,
  MAX_ID_BYTES,
  MAX_LABEL_BYTES,
  MAX_MODEL_ID_BYTES,
  MAX_PATH_BYTES,
  MAX_PROMPT_BYTES,
  MAX_PROVIDER_OPTION_ENTRIES,
  MAX_SESSION_CONFIGURATION_BYTES,
  MAX_VIEWPORT_PX,
  utf8ByteLength,
} from './bridgeSchemas/commandBounds.js';
import { sessionTargetSchema } from './providers/providerIdentity.js';

const MARKER = 'untrusted-payload-marker';

const configuration: Extract<ClientCommand, { type: 'session.create' }>['configuration'] = {
  providerSelection: {
    providerInstanceId: 'droid',
    modelId: 'model-a',
    options: { reasoningEffort: 'high' },
  },
  interactionMode: 'auto',
  autonomy: 'medium',
};

const designReference: Extract<
  ClientCommand,
  { type: 'browser.design.addReference' }
>['reference'] = {
  id: 'ref-1',
  anchor: {
    id: 'anchor-1',
    kind: 'element',
    label: 'Hero',
    box: { x: 0, y: 0, width: 10, height: 10 },
  },
  url: 'https://example.test',
};

const nativeResult: Extract<ClientCommand, { type: 'browser.native.result' }>['result'] = {
  requestId: 'req-1',
  appSessionId: 'app-1',
  browserSessionId: 'browser-1',
  ok: true,
};

const validCommands = {
  connect: { type: 'connect' },
  'runtime.status': { type: 'runtime.status' },
  'auth.status': { type: 'auth.status' },
  'env.detect': { type: 'env.detect' },
  'cli.install': { type: 'cli.install', channel: 'npm' },
  'cli.update': { type: 'cli.update' },
  'catalog.models': { type: 'catalog.models' },
  'catalog.tools': { type: 'catalog.tools' },
  'catalog.skills': { type: 'catalog.skills' },
  'settings.defaults': { type: 'settings.defaults' },
  'session.create': {
    type: 'session.create',
    clientRef: 'ref-1',
    title: 'Title',
    goal: 'Goal',
    sessionPurpose: 'chat',
    configuration,
  },
  'session.send': { type: 'session.send', appSessionId: 'app-1', text: 'hello' },
  'session.sendNow': { type: 'session.sendNow', appSessionId: 'app-1', text: 'hello' },
  'session.resume': { type: 'session.resume', appSessionId: 'app-1' },
  'session.interrupt': { type: 'session.interrupt', appSessionId: 'app-1' },
  'session.updateSettings': {
    type: 'session.updateSettings',
    appSessionId: 'app-1',
    configuration,
  },
  'session.compact': { type: 'session.compact', appSessionId: 'app-1' },
  'session.fork': { type: 'session.fork', appSessionId: 'app-1' },
  'session.rename': { type: 'session.rename', appSessionId: 'app-1', title: 'Renamed' },
  'session.exportMarkdown': {
    type: 'session.exportMarkdown',
    appSessionId: 'app-1',
    requestId: 'req-1',
  },
  'sessions.reanchorCwd': {
    type: 'sessions.reanchorCwd',
    requestId: 'req-1',
    fromCwd: '/old',
    toCwd: '/new',
  },
  'session.rewindInfo': { type: 'session.rewindInfo', appSessionId: 'app-1' },
  'session.rewind': { type: 'session.rewind', appSessionId: 'app-1' },
  'session.close': { type: 'session.close', appSessionId: 'app-1' },
  'sessions.list': { type: 'sessions.list' },
  'session.loadHistory': { type: 'session.loadHistory', appSessionId: 'app-1' },
  'sessions.search': { type: 'sessions.search', requestId: 'req-1', query: 'hello' },
  'history.indexingIdle': { type: 'history.indexingIdle', isIdle: true },
  'app.backgroundWork': { type: 'app.backgroundWork', tier: 'interactive' },
  'child.open': {
    type: 'child.open',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    requestId: 'req-1',
  },
  'child.send': {
    type: 'child.send',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    text: 'hello',
  },
  'child.sendNow': {
    type: 'child.sendNow',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    text: 'hello',
  },
  'child.interrupt': {
    type: 'child.interrupt',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
  },
  'child.loadHistory': {
    type: 'child.loadHistory',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
  },
  'child.updateSettings': {
    type: 'child.updateSettings',
    parentAppSessionId: 'app-1',
    childSessionId: 'child-1',
    modelId: 'model-a',
  },
  'approval.respond': {
    type: 'approval.respond',
    appSessionId: 'app-1',
    requestId: 'req-1',
    outcome: 'proceed_once',
  },
  'question.respond': {
    type: 'question.respond',
    appSessionId: 'app-1',
    requestId: 'req-1',
    cancelled: false,
    answers: [{ index: 0, question: 'Q', answer: 'A' }],
  },
  'settings.agent.update': { type: 'settings.agent.update', agent: 'primary' },
  'settings.compaction.update': { type: 'settings.compaction.update' },
  'browser.open': { type: 'browser.open', appSessionId: 'app-1', url: 'https://example.test' },
  'browser.close': { type: 'browser.close', appSessionId: 'app-1' },
  'browser.reload': { type: 'browser.reload', appSessionId: 'app-1' },
  'browser.refresh': { type: 'browser.refresh', appSessionId: 'app-1' },
  'browser.resizeViewport': {
    type: 'browser.resizeViewport',
    appSessionId: 'app-1',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    viewportMode: 'desktop',
  },
  'browser.click': { type: 'browser.click', appSessionId: 'app-1', x: 1, y: 2 },
  'browser.type': { type: 'browser.type', appSessionId: 'app-1', text: 'hello' },
  'browser.keypress': { type: 'browser.keypress', appSessionId: 'app-1', key: 'Enter' },
  'browser.scroll': { type: 'browser.scroll', appSessionId: 'app-1', direction: 'down' },
  'browser.screenshot': { type: 'browser.screenshot', appSessionId: 'app-1' },
  'browser.inspectPoint': { type: 'browser.inspectPoint', appSessionId: 'app-1', x: 3, y: 4 },
  'browser.design.addReference': {
    type: 'browser.design.addReference',
    appSessionId: 'app-1',
    reference: designReference,
  },
  'browser.design.sendPrompt': {
    type: 'browser.design.sendPrompt',
    appSessionId: 'app-1',
    instruction: 'restyle',
    referenceIds: ['ref-1'],
  },
  'browser.native.result': { type: 'browser.native.result', result: nativeResult },
  'mcp.list': { type: 'mcp.list', requestId: 'req-1' },
  'mcp.add': {
    type: 'mcp.add',
    requestId: 'req-1',
    server: { name: 'linear', serverType: 'http', url: 'https://mcp.example.test' },
  },
  'mcp.remove': { type: 'mcp.remove', requestId: 'req-1', serverName: 'linear' },
  'mcp.toggle': {
    type: 'mcp.toggle',
    requestId: 'req-1',
    serverName: 'linear',
    enabled: false,
  },
  'mcp.authenticate': { type: 'mcp.authenticate', requestId: 'req-1', serverName: 'linear' },
} satisfies { [K in ClientCommand['type']]: Extract<ClientCommand, { type: K }> };

const CLIENT_COMMAND_TYPES = Object.keys(validCommands) as ClientCommand['type'][];

function parseObject(value: unknown) {
  return parseBridgeCommand(Buffer.from(JSON.stringify(value)), false);
}

function assertInvalid(result: ReturnType<typeof parseBridgeCommand>, markers: string[] = []) {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'invalid_bridge_frame');
  assert.equal(result.closeCode, undefined);
  assert.equal(result.message.includes(MARKER), false);
  for (const marker of markers) {
    assert.equal(result.message.includes(marker), false, `error echoed ${marker}`);
  }
}

function bytesOf(count: number, char = 'a'): string {
  return char.repeat(count);
}

test('every ClientCommand discriminant has exactly one valid fixture', () => {
  assert.equal(CLIENT_COMMAND_TYPES.length, 58);
  for (const type of CLIENT_COMMAND_TYPES) {
    const result = parseObject(validCommands[type]);
    assert.equal(result.ok, true, type);
    if (result.ok) assert.equal(result.command.type, type);
  }
});

for (const type of CLIENT_COMMAND_TYPES) {
  test(`accepts a valid ${type} command`, () => {
    const result = parseObject(validCommands[type]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.command, validCommands[type]);
  });
}

test('invalid JSON is rejected without a close code', () => {
  const result = parseBridgeCommand(Buffer.from(`{"type":"${MARKER}"`), false);
  assertInvalid(result, [MARKER]);
});

test('null and array roots are rejected', () => {
  assertInvalid(parseObject(null));
  assertInvalid(parseObject([validCommands['runtime.status']]));
});

test('unknown command discriminants are rejected', () => {
  assertInvalid(parseObject({ type: `session.delete-${MARKER}` }), [`session.delete-${MARKER}`]);
});

test('missing required fields are rejected', () => {
  assertInvalid(parseObject({ type: 'session.send', text: MARKER }), [MARKER]);
  assertInvalid(parseObject({ type: 'cli.install' }));
});

test('extra unknown fields are rejected', () => {
  assertInvalid(parseObject({ type: 'runtime.status', extra: MARKER }), [MARKER]);
});

test('invalid enum values are rejected', () => {
  assertInvalid(parseObject({ type: 'cli.install', channel: MARKER }), [MARKER]);
  assertInvalid(
    parseObject({
      type: 'approval.respond',
      appSessionId: 'app-1',
      requestId: 'req-1',
      outcome: MARKER,
    }),
    [MARKER],
  );
});

test('invalid nested union values are rejected', () => {
  assertInvalid(
    parseObject({
      type: 'mcp.add',
      requestId: 'req-1',
      server: { name: MARKER, serverType: 'http', command: 'npx' },
    }),
    [MARKER],
  );
  assertInvalid(
    parseObject({
      type: 'mcp.add',
      requestId: 'req-1',
      server: { name: MARKER, serverType: 'stdio', url: 'https://example.test' },
    }),
    [MARKER],
  );
});

test('malformed SessionTarget values are rejected', () => {
  assert.equal(
    sessionTargetSchema.safeParse({ kind: 'session', appSessionId: MARKER }).success,
    true,
  );
  assert.equal(
    sessionTargetSchema.safeParse({
      kind: 'session',
      appSessionId: 'app-1',
      childSessionId: MARKER,
    }).success,
    false,
  );
  assert.equal(
    sessionTargetSchema.safeParse({ kind: 'child', parentAppSessionId: 'p' }).success,
    false,
  );
  assertInvalid(
    parseObject({
      type: 'session.send',
      appSessionId: { kind: 'session', appSessionId: MARKER },
      text: 'hello',
    }),
    [MARKER],
  );
});

test('provider option values that are not string | number | boolean are rejected', () => {
  for (const bad of [null, { nested: MARKER }, [MARKER]]) {
    assertInvalid(
      parseObject({
        type: 'session.updateSettings',
        appSessionId: 'app-1',
        configuration: {
          providerSelection: {
            providerInstanceId: 'droid',
            modelId: 'model-a',
            options: { [MARKER]: bad },
          },
          interactionMode: 'auto',
          autonomy: 'medium',
        },
      }),
      [MARKER],
    );
  }
});

test('more than 64 provider option entries are rejected', () => {
  const options: Record<string, string> = {};
  for (let index = 0; index <= MAX_PROVIDER_OPTION_ENTRIES; index += 1) {
    options[`k${String(index)}`] = 'v';
  }
  assert.equal(Object.keys(options).length, MAX_PROVIDER_OPTION_ENTRIES + 1);
  assertInvalid(
    parseObject({
      type: 'session.create',
      clientRef: 'ref-1',
      title: 'Title',
      goal: 'Goal',
      sessionPurpose: 'chat',
      configuration: {
        providerSelection: { providerInstanceId: 'droid', modelId: 'model-a', options },
        interactionMode: 'auto',
        autonomy: 'medium',
      },
    }),
  );
});

test('an oversized SessionConfiguration is rejected', () => {
  const oversized = {
    providerSelection: {
      providerInstanceId: 'droid' as const,
      modelId: 'model-a',
      options: { blob: bytesOf(MAX_SESSION_CONFIGURATION_BYTES) },
    },
    interactionMode: 'auto' as const,
    autonomy: 'medium' as const,
  };
  assert.ok(utf8ByteLength(JSON.stringify(oversized)) > MAX_SESSION_CONFIGURATION_BYTES);
  assertInvalid(
    parseObject({
      type: 'session.updateSettings',
      appSessionId: 'app-1',
      configuration: oversized,
    }),
  );
});

test('64 provider option entries at the list cap are accepted', () => {
  const options: Record<string, boolean> = {};
  for (let index = 0; index < MAX_PROVIDER_OPTION_ENTRIES; index += 1) {
    options[`k${String(index)}`] = true;
  }
  const result = parseObject({
    type: 'session.updateSettings',
    appSessionId: 'app-1',
    configuration: {
      providerSelection: { providerInstanceId: 'droid', modelId: 'model-a', options },
      interactionMode: 'auto',
      autonomy: 'medium',
    },
  });
  assert.equal(result.ok, true);
});

test('ID, model ID, title, path, prompt, and list boundaries are enforced', () => {
  assert.equal(
    parseObject({ type: 'session.send', appSessionId: bytesOf(MAX_ID_BYTES), text: 'ok' }).ok,
    true,
  );
  assertInvalid(
    parseObject({ type: 'session.send', appSessionId: bytesOf(MAX_ID_BYTES + 1), text: 'ok' }),
  );

  const atModelId = {
    ...configuration,
    providerSelection: {
      ...configuration.providerSelection,
      modelId: bytesOf(MAX_MODEL_ID_BYTES),
    },
  };
  const overModelId = {
    ...configuration,
    providerSelection: {
      ...configuration.providerSelection,
      modelId: bytesOf(MAX_MODEL_ID_BYTES + 1),
    },
  };
  assert.equal(
    parseObject({
      type: 'session.updateSettings',
      appSessionId: 'app-1',
      configuration: atModelId,
    }).ok,
    true,
  );
  assertInvalid(
    parseObject({
      type: 'session.updateSettings',
      appSessionId: 'app-1',
      configuration: overModelId,
    }),
  );

  assert.equal(
    parseObject({
      type: 'session.rename',
      appSessionId: 'app-1',
      title: bytesOf(MAX_CHAT_TITLE_CHARS),
    }).ok,
    true,
  );
  assertInvalid(
    parseObject({
      type: 'session.rename',
      appSessionId: 'app-1',
      title: bytesOf(MAX_CHAT_TITLE_CHARS + 1),
    }),
  );

  assert.equal(
    parseObject({
      type: 'sessions.reanchorCwd',
      requestId: 'req-1',
      fromCwd: `/${bytesOf(MAX_PATH_BYTES - 1)}`,
      toCwd: '/new',
    }).ok,
    true,
  );
  assertInvalid(
    parseObject({
      type: 'sessions.reanchorCwd',
      requestId: 'req-1',
      fromCwd: `/${bytesOf(MAX_PATH_BYTES)}`,
      toCwd: '/new',
    }),
  );

  assert.equal(
    parseObject({
      type: 'session.send',
      appSessionId: 'app-1',
      text: bytesOf(MAX_PROMPT_BYTES),
    }).ok,
    true,
  );
  assertInvalid(
    parseObject({
      type: 'session.send',
      appSessionId: 'app-1',
      text: bytesOf(MAX_PROMPT_BYTES + 1),
    }),
  );

  const sixtyFourCwds = Array.from(
    { length: MAX_BRIDGE_LIST_ITEMS },
    (_, index) => `/${String(index)}`,
  );
  const sixtyFiveCwds = [...sixtyFourCwds, '/extra'];
  assert.equal(parseObject({ type: 'sessions.list', workspaceCwds: sixtyFourCwds }).ok, true);
  assertInvalid(parseObject({ type: 'sessions.list', workspaceCwds: sixtyFiveCwds }));

  const sixtyFourAnswers = Array.from({ length: MAX_BRIDGE_LIST_ITEMS }, (_, index) => ({
    index,
    question: 'Q',
    answer: 'A',
  }));
  assert.equal(
    parseObject({
      type: 'question.respond',
      appSessionId: 'app-1',
      requestId: 'req-1',
      cancelled: false,
      answers: sixtyFourAnswers,
    }).ok,
    true,
  );
  assertInvalid(
    parseObject({
      type: 'question.respond',
      appSessionId: 'app-1',
      requestId: 'req-1',
      cancelled: false,
      answers: [...sixtyFourAnswers, { index: 64, question: 'Q', answer: 'A' }],
    }),
  );

  const sixtyFourRefs = Array.from(
    { length: MAX_BRIDGE_LIST_ITEMS },
    (_, index) => `ref-${String(index)}`,
  );
  assert.equal(
    parseObject({
      type: 'browser.design.sendPrompt',
      appSessionId: 'app-1',
      instruction: 'go',
      referenceIds: sixtyFourRefs,
    }).ok,
    true,
  );
  assertInvalid(
    parseObject({
      type: 'browser.design.sendPrompt',
      appSessionId: 'app-1',
      instruction: 'go',
      referenceIds: [...sixtyFourRefs, 'extra'],
    }),
  );

  assert.equal(
    parseObject({
      type: 'session.loadHistory',
      appSessionId: 'app-1',
      limit: MAX_HISTORY_PAGE_EVENTS,
    }).ok,
    true,
  );
  assertInvalid(
    parseObject({
      type: 'session.loadHistory',
      appSessionId: 'app-1',
      limit: MAX_HISTORY_PAGE_EVENTS + 1,
    }),
  );

  assert.equal(
    parseObject({
      type: 'browser.keypress',
      appSessionId: 'app-1',
      key: bytesOf(MAX_LABEL_BYTES),
    }).ok,
    true,
  );
  assertInvalid(
    parseObject({
      type: 'browser.keypress',
      appSessionId: 'app-1',
      key: bytesOf(MAX_LABEL_BYTES + 1),
    }),
  );

  assertInvalid(
    parseObject({
      type: 'browser.open',
      appSessionId: 'app-1',
      url: 'https://example.test',
      viewport: { width: MAX_VIEWPORT_PX + 1, height: 800, deviceScaleFactor: 1 },
    }),
  );
});

test('invalid UTF-8 closes with 1003', () => {
  const result = parseBridgeCommand(Buffer.from([0xc3, 0x28]), false);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.closeCode, 1003);
  assert.equal(result.code, 'invalid_bridge_frame');
});

test('a binary frame closes with 1003', () => {
  const result = parseBridgeCommand(
    Buffer.from(JSON.stringify(validCommands['runtime.status'])),
    true,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.closeCode, 1003);
  assert.equal(result.message.includes('runtime.status'), false);
});

test('frames one byte below, exactly at, and one byte above the cap', () => {
  const below = sizedNativeResultFrame(MAX_BRIDGE_FRAME_BYTES - 1);
  const exact = sizedNativeResultFrame(MAX_BRIDGE_FRAME_BYTES);
  const above = sizedNativeResultFrame(MAX_BRIDGE_FRAME_BYTES + 1);

  assert.equal(below.byteLength, MAX_BRIDGE_FRAME_BYTES - 1);
  assert.equal(exact.byteLength, MAX_BRIDGE_FRAME_BYTES);
  assert.equal(above.byteLength, MAX_BRIDGE_FRAME_BYTES + 1);

  const belowResult = parseBridgeCommand(below, false);
  const exactResult = parseBridgeCommand(exact, false);
  const aboveResult = parseBridgeCommand(above, false);

  assert.equal(belowResult.ok, true);
  assert.equal(exactResult.ok, true);
  assert.equal(aboveResult.ok, false);
  if (aboveResult.ok) return;
  assert.equal(aboveResult.code, 'bridge_frame_too_large');
  assert.equal(aboveResult.closeCode, 1009);
});

test('fragmented raw data whose combined size exceeds the cap is rejected with 1009', () => {
  const first = Buffer.alloc(MAX_BRIDGE_FRAME_BYTES - 10, 0x61);
  const second = Buffer.alloc(20, 0x61);
  const result = parseBridgeCommand([first, second], false);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'bridge_frame_too_large');
  assert.equal(result.closeCode, 1009);
  assert.equal(result.message.includes('a'.repeat(20)), false);
});

test('error text never includes submitted payload content', () => {
  const payloads = [
    { type: 'session.send', appSessionId: MARKER, extra: 'leak' },
    { type: MARKER },
    { type: 'session.create', clientRef: MARKER },
  ];
  for (const payload of payloads) {
    const result = parseObject(payload);
    assertInvalid(result, [MARKER, 'leak']);
  }
});

function sizedNativeResultFrame(size: number): Buffer {
  const prefix =
    '{"type":"browser.native.result","result":{"requestId":"r","appSessionId":"a","browserSessionId":"b","ok":true,"image":"';
  const suffix = '"}}';
  const overhead = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  assert.ok(size >= overhead);
  return Buffer.concat([
    Buffer.from(prefix),
    Buffer.alloc(size - overhead, 0x61),
    Buffer.from(suffix),
  ]);
}
