import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  decodeJsonRpcLine,
  encodeJsonRpcError,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeJsonRpcResult,
  isJsonRpcId,
  jsonRpcIdKey,
  type JsonRpcId,
} from '../../acp/acpJsonRpc.js';

export const CURSOR_FAKE_ENV = 'DROIDEX_CURSOR_FAKE';
export const CURSOR_FAKE_ABOUT_ENV = 'DROIDEX_CURSOR_FAKE_ABOUT';
export const CURSOR_FAKE_MODELS_ENV = 'DROIDEX_CURSOR_FAKE_MODELS';
export const CURSOR_FAKE_MODES_ENV = 'DROIDEX_CURSOR_FAKE_MODES';
export const CURSOR_FAKE_PROMPT_ENV = 'DROIDEX_CURSOR_FAKE_PROMPT';
export const CURSOR_FAKE_REPLAY_ENV = 'DROIDEX_CURSOR_FAKE_REPLAY';
export const CURSOR_FAKE_FLOOD_ENV = 'DROIDEX_CURSOR_FAKE_FLOOD';
export const CURSOR_FAKE_SESSION_ID_ENV = 'DROIDEX_CURSOR_FAKE_SESSION_ID';
export const CURSOR_FAKE_EXTRA_UPDATES_ENV = 'DROIDEX_CURSOR_FAKE_EXTRA_UPDATES';
export const CURSOR_FAKE_SCRIPT_ENV = 'DROIDEX_CURSOR_FAKE_SCRIPT';

export type CursorFakeAbout =
  | 'json'
  | 'text'
  | 'format-unsupported'
  | 'ansi'
  | 'not-logged-in'
  | 'login-required'
  | 'auth-required'
  | 'null-email'
  | 'missing-email'
  | 'error-exit';

export type CursorFakePrompt = 'complete' | 'hang' | 'reject' | 'wait-cancel';

export function fakeCursorAgentPath(): string {
  return fileURLToPath(new URL('./fakeCursorAgent.ts', import.meta.url));
}

export function fakeCursorAgentSpawn(overrides: NodeJS.ProcessEnv = {}): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  return {
    command: process.execPath,
    args: ['--import', 'tsx', fakeCursorAgentPath()],
    env: {
      ...process.env,
      [CURSOR_FAKE_ENV]: '1',
      [CURSOR_FAKE_ABOUT_ENV]: 'json',
      [CURSOR_FAKE_PROMPT_ENV]: 'complete',
      [CURSOR_FAKE_SESSION_ID_ENV]: 'mock-session-1',
      [CURSOR_FAKE_MODES_ENV]: 'code,plan',
      ...overrides,
    },
  };
}

if (process.env[CURSOR_FAKE_ENV] === '1') {
  void runFakeCursorAgent();
}

async function runFakeCursorAgent(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('about')) {
    handleAbout(args);
    return;
  }
  await runAcpPeer();
}

function handleAbout(args: string[]): void {
  const behavior = parseAboutBehavior(process.env[CURSOR_FAKE_ABOUT_ENV]);
  const wantsJson = args.includes('--format') && args.includes('json');
  if (behavior === 'format-unsupported' && wantsJson) {
    process.stderr.write("unknown option '--format'\n");
    process.exitCode = 1;
    return;
  }
  if (behavior === 'error-exit') {
    process.stderr.write('failed\n');
    process.exitCode = 1;
    return;
  }

  const json = (payload: unknown) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const text = (version: string, email: string) => {
    process.stdout.write(
      `About Cursor CLI\n\nCLI Version         ${version}\nUser Email          ${email}\n`,
    );
  };

  switch (behavior) {
    case 'text':
    case 'format-unsupported':
      text('2026.04.09-f2b0fcd', 'cursor@example.com');
      return;
    case 'ansi':
      process.stdout.write(
        `\u001b[32mCLI Version         2026.04.09-f2b0fcd\u001b[0m\nUser Email          cursor@example.com\n`,
      );
      return;
    case 'not-logged-in':
      json({ cliVersion: '2026.04.09-f2b0fcd', userEmail: 'Not logged in' });
      return;
    case 'login-required':
      json({ cliVersion: '2026.04.09-f2b0fcd', userEmail: 'login required' });
      return;
    case 'auth-required':
      json({ cliVersion: '2026.04.09-f2b0fcd', userEmail: 'authentication required' });
      return;
    case 'null-email':
      json({ cliVersion: '2026.04.09-f2b0fcd', userEmail: null });
      return;
    case 'missing-email':
      json({ cliVersion: '2026.04.09-f2b0fcd' });
      return;
    case 'json':
    default:
      json({
        cliVersion: '2026.04.09-f2b0fcd',
        userEmail: 'cursor@example.com',
        subscriptionTier: 'Pro',
      });
  }
}

async function runAcpPeer(): Promise<void> {
  const sessionId = process.env[CURSOR_FAKE_SESSION_ID_ENV] || 'mock-session-1';
  const promptBehavior = parsePromptBehavior(process.env[CURSOR_FAKE_PROMPT_ENV]);
  const script = parseFakeScript(process.env[CURSOR_FAKE_SCRIPT_ENV]);
  const receivedMethods: string[] = [];
  const setModelCalls: unknown[] = [];
  const setModeCalls: unknown[] = [];
  const lastInteractions: unknown[] = [];
  let initializeParams: unknown;
  let cancelled = false;
  let promptRequestId: JsonRpcId | undefined;
  const pendingServerRequests = new Map<string, (message: unknown) => void>();

  const write = (line: string): void => {
    process.stdout.write(line);
  };
  const respond = (id: JsonRpcId, result: unknown): void => {
    write(encodeJsonRpcResult(id, result));
  };
  const fail = (id: JsonRpcId, message: string): void => {
    write(encodeJsonRpcError(id, -32000, message));
  };
  const waitForClientResponse = (id: JsonRpcId): Promise<unknown> =>
    new Promise((resolve) => {
      pendingServerRequests.set(jsonRpcIdKey(id), resolve);
    });

  const modes = advertisedModes();
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.length === 0) continue;
    const decoded = decodeJsonRpcLine(line);
    if (!decoded.ok) continue;
    const message = decoded.message;
    if ((message.kind === 'success' || message.kind === 'error') && isJsonRpcId(message.id)) {
      const waiter = pendingServerRequests.get(jsonRpcIdKey(message.id));
      if (waiter) {
        pendingServerRequests.delete(jsonRpcIdKey(message.id));
        waiter(message);
      }
      continue;
    }
    if (message.kind === 'notification') {
      if (message.method === 'session/cancel') {
        cancelled = true;
        if (promptRequestId !== undefined && promptBehavior === 'wait-cancel') {
          respond(promptRequestId, { stopReason: 'cancelled' });
          promptRequestId = undefined;
        }
      }
      continue;
    }
    if (message.kind !== 'request') continue;

    receivedMethods.push(message.method);
    if (message.method === 'initialize') {
      initializeParams = message.params;
      respond(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      continue;
    }
    if (message.method === 'authenticate') {
      respond(message.id, {});
      continue;
    }
    if (message.method === 'session/new') {
      emitFlood(write, sessionId);
      respond(message.id, {
        sessionId,
        modes: { currentModeId: modes[0]?.id ?? 'code', availableModes: modes },
        receivedMethods: [...receivedMethods],
      });
      continue;
    }
    if (message.method === 'session/load') {
      const requestedSessionId = readRequestedSessionId(message.params) ?? sessionId;
      if (process.env[CURSOR_FAKE_REPLAY_ENV] === '1') {
        write(
          encodeJsonRpcNotification('session/update', {
            sessionId: requestedSessionId,
            _meta: { isReplay: true },
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'replayed assistant text' },
            },
          }),
        );
        write(
          encodeJsonRpcNotification('session/update', {
            sessionId: requestedSessionId,
            _meta: { isReplay: true },
            update: { sessionUpdate: 'tool_call', toolCallId: 'replay-tool-1' },
          }),
        );
        write(
          encodeJsonRpcNotification('session/update', {
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'live after replay' },
            },
          }),
        );
      }
      respond(message.id, {
        modes: { currentModeId: modes[0]?.id ?? 'code', availableModes: modes },
        receivedMethods: [...receivedMethods],
      });
      continue;
    }
    if (message.method === 'session/set_model') {
      setModelCalls.push(message.params);
      respond(message.id, {});
      continue;
    }
    if (message.method === 'session/set_mode') {
      setModeCalls.push(message.params);
      respond(message.id, {});
      continue;
    }
    if (message.method === 'cursor/list_available_models') {
      respond(message.id, { models: availableModels() });
      continue;
    }
    if (message.method === 'x/received-methods') {
      respond(message.id, { receivedMethods: [...receivedMethods] });
      continue;
    }
    if (message.method === 'x/handshake') {
      respond(message.id, { initializeParams, setModelCalls, setModeCalls });
      continue;
    }
    if (message.method === 'x/last-interactions') {
      respond(message.id, { lastInteractions: [...lastInteractions] });
      continue;
    }
    if (message.method === 'x/crash') {
      process.exit(7);
    }
    if (message.method === 'session/prompt') {
      if (promptBehavior === 'hang' && script.length === 0) {
        continue;
      }
      if (promptBehavior === 'reject') {
        queueMicrotask(() => fail(message.id, 'prompt rejected'));
        continue;
      }
      if (promptBehavior === 'wait-cancel' && script.length === 0) {
        promptRequestId = message.id;
        continue;
      }
      if (script.length > 0) {
        void runPromptScript({
          script,
          sessionId,
          promptId: message.id,
          write,
          respond,
          waitForClientResponse,
          lastInteractions,
          wasCancelled: () => cancelled,
        });
        continue;
      }
      emitLiveUpdates(write, sessionId);
      respond(message.id, { stopReason: cancelled ? 'cancelled' : 'end_turn' });
      continue;
    }
    respond(message.id, {});
  }
}

function advertisedModes(): Array<{ id: string; name: string }> {
  const raw = process.env[CURSOR_FAKE_MODES_ENV] ?? 'code,plan';
  if (raw.trim() === '') {
    return [];
  }
  return raw.split(',').map((id) => {
    const trimmed = id.trim();
    return { id: trimmed, name: trimmed };
  });
}

function availableModels(): Array<{ value: string; name: string }> {
  const raw = process.env[CURSOR_FAKE_MODELS_ENV];
  if (raw === '') {
    return [];
  }
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.flatMap((entry) => {
          if (!isPlainObject(entry)) {
            return [];
          }
          const value = entry.value;
          const name = entry.name;
          if (typeof value !== 'string' || typeof name !== 'string') {
            return [];
          }
          return [{ value, name }];
        });
      }
    } catch {
      return [];
    }
  }
  return [
    {
      value: 'gpt-5.4-medium-fast[reasoning=medium,context=272k]',
      name: 'GPT-5.4',
    },
    { value: 'default', name: 'Auto' },
  ];
}

function emitFlood(write: (line: string) => void, sessionId: string): void {
  const count = Number(process.env[CURSOR_FAKE_FLOOD_ENV] ?? '0');
  for (let index = 0; index < count; index += 1) {
    write(
      encodeJsonRpcNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `flood-${index}` },
        },
      }),
    );
  }
}

function emitLiveUpdates(write: (line: string) => void, sessionId: string): void {
  write(
    encodeJsonRpcNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello from cursor' },
      },
    }),
  );
  if (process.env[CURSOR_FAKE_EXTRA_UPDATES_ENV] === '1') {
    write(
      encodeJsonRpcNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'secret thought' },
        },
      }),
    );
    write(
      encodeJsonRpcNotification('session/update', {
        sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1' },
      }),
    );
    write(
      encodeJsonRpcNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', data: 'nope' },
        },
      }),
    );
  }
}

function parseFakeScript(raw: string | undefined): FakeScriptStep[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is FakeScriptStep => isPlainObject(entry) && typeof entry.type === 'string',
    );
  } catch {
    return [];
  }
}

type FakeScriptStep = {
  type: string;
  id?: JsonRpcId;
  kind?: string;
  title?: string;
  toolCallId?: string;
  options?: unknown;
  payload?: unknown;
  text?: string;
  method?: string;
  crashAfterSend?: boolean;
};

const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

async function runPromptScript(input: {
  script: FakeScriptStep[];
  sessionId: string;
  promptId: JsonRpcId;
  write: (line: string) => void;
  respond: (id: JsonRpcId, result: unknown) => void;
  waitForClientResponse: (id: JsonRpcId) => Promise<unknown>;
  lastInteractions: unknown[];
  wasCancelled: () => boolean;
}): Promise<void> {
  let nextId = 10_000;
  for (const step of input.script) {
    if (step.type === 'text') {
      input.write(
        encodeJsonRpcNotification('session/update', {
          sessionId: input.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: step.text ?? '' },
          },
        }),
      );
      continue;
    }
    if (step.type === 'tool_call' || step.type === 'tool_call_update') {
      const payload = isPlainObject(step.payload) ? step.payload : {};
      input.write(
        encodeJsonRpcNotification('session/update', {
          sessionId: input.sessionId,
          update: {
            sessionUpdate: step.type,
            toolCallId: step.toolCallId ?? 'tool-1',
            ...payload,
          },
        }),
      );
      continue;
    }
    if (step.type === 'update_todos') {
      input.write(encodeJsonRpcNotification('cursor/update_todos', step.payload ?? {}));
      continue;
    }
    if (step.type === 'crash') {
      process.exit(7);
    }
    if (
      step.type === 'permission' ||
      step.type === 'ask_question' ||
      step.type === 'create_plan' ||
      step.type === 'malformed_request'
    ) {
      const id = step.id ?? nextId;
      nextId += 1;
      const method =
        step.type === 'permission'
          ? 'session/request_permission'
          : step.type === 'ask_question'
            ? 'cursor/ask_question'
            : step.type === 'create_plan'
              ? 'cursor/create_plan'
              : (step.method ?? 'cursor/ask_question');
      const params =
        step.type === 'permission'
          ? {
              sessionId: input.sessionId,
              toolCall: {
                toolCallId: step.toolCallId ?? 'tool-1',
                kind: step.kind ?? 'execute',
                title: step.title ?? 'Allow mock action',
              },
              options: Array.isArray(step.options) ? step.options : DEFAULT_PERMISSION_OPTIONS,
            }
          : (step.payload ?? {});
      input.write(encodeJsonRpcRequest(id, method, params));
      if (step.crashAfterSend === true) {
        process.exit(7);
      }
      const reply = await input.waitForClientResponse(id);
      input.lastInteractions.push({
        method,
        id,
        idType: typeof id,
        reply,
      });
      continue;
    }
  }
  input.respond(input.promptId, {
    stopReason: input.wasCancelled() ? 'cancelled' : 'end_turn',
  });
}

function readRequestedSessionId(params: unknown): string | undefined {
  if (!isPlainObject(params)) {
    return undefined;
  }
  const sessionId = params.sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAboutBehavior(value: string | undefined): CursorFakeAbout {
  switch (value) {
    case 'text':
    case 'format-unsupported':
    case 'ansi':
    case 'not-logged-in':
    case 'login-required':
    case 'auth-required':
    case 'null-email':
    case 'missing-email':
    case 'error-exit':
    case 'json':
      return value;
    default:
      return 'json';
  }
}

function parsePromptBehavior(value: string | undefined): CursorFakePrompt {
  switch (value) {
    case 'hang':
    case 'reject':
    case 'wait-cancel':
    case 'complete':
      return value;
    default:
      return 'complete';
  }
}
