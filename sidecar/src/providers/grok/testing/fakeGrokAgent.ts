import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  decodeJsonRpcLine,
  encodeJsonRpcError,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeJsonRpcResult,
  type JsonRpcId,
} from '../../acp/acpJsonRpc.js';

export const GROK_FAKE_ENV = 'DROIDEX_GROK_FAKE';
export const GROK_FAKE_VERSION_ENV = 'DROIDEX_GROK_FAKE_VERSION';
export const GROK_FAKE_MODELS_ENV = 'DROIDEX_GROK_FAKE_MODELS';
export const GROK_FAKE_PROMPT_ENV = 'DROIDEX_GROK_FAKE_PROMPT';
export const GROK_FAKE_SESSION_ID_ENV = 'DROIDEX_GROK_FAKE_SESSION_ID';
export const GROK_FAKE_FLOOD_ENV = 'DROIDEX_GROK_FAKE_FLOOD';
export const GROK_FAKE_EXTENSION_ENV = 'DROIDEX_GROK_FAKE_EXTENSION';
export const GROK_FAKE_PLAN_DETECT_ENV = 'DROIDEX_GROK_FAKE_PLAN_DETECT';
export const GROK_FAKE_PERMISSION_COUNT_ENV = 'DROIDEX_GROK_FAKE_PERMISSION_COUNT';
export const GROK_FAKE_SECOND_PERMISSION_COMMAND_ENV =
  'DROIDEX_GROK_FAKE_SECOND_PERMISSION_COMMAND';

export type GrokFakePrompt =
  | 'complete'
  | 'hang'
  | 'prompt-complete'
  | 'both'
  | 'rate-limit-rpc'
  | 'rate-limit-complete'
  | 'reject'
  | 'wait-cancel'
  | 'permission'
  | 'question'
  | 'plan'
  | 'plan-twice';

export function fakeGrokAgentPath(): string {
  return fileURLToPath(new URL('./fakeGrokAgent.ts', import.meta.url));
}

export function fakeGrokAgentSpawn(overrides: NodeJS.ProcessEnv = {}): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  return {
    command: process.execPath,
    args: ['--import', 'tsx', fakeGrokAgentPath()],
    env: {
      ...process.env,
      [GROK_FAKE_ENV]: '1',
      [GROK_FAKE_VERSION_ENV]: '1.2.3',
      [GROK_FAKE_PROMPT_ENV]: 'complete',
      [GROK_FAKE_SESSION_ID_ENV]: 'mock-session-1',
      ...overrides,
    },
  };
}

if (process.env[GROK_FAKE_ENV] === '1') {
  void runFakeGrokAgent();
}

async function runFakeGrokAgent(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    handleVersion();
    return;
  }
  await runAcpPeer(args);
}

function handleVersion(): void {
  const behavior = process.env[GROK_FAKE_VERSION_ENV] ?? '1.2.3';
  if (behavior === 'hang') {
    return;
  }
  if (behavior === 'fail') {
    process.stderr.write('failed\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`grok ${behavior}\n`);
}

async function runAcpPeer(spawnArgs: readonly string[]): Promise<void> {
  const sessionId = process.env[GROK_FAKE_SESSION_ID_ENV] || 'mock-session-1';
  const promptBehavior = parsePromptBehavior(process.env[GROK_FAKE_PROMPT_ENV]);
  const extensionPrefix = process.env[GROK_FAKE_EXTENSION_ENV] === 'unprefixed' ? '' : '_';
  const receivedMethods: string[] = [];
  const setModelCalls: unknown[] = [];
  const permissionResults: unknown[] = [];
  const questionResults: unknown[] = [];
  const exitPlanResults: unknown[] = [];
  let initializeParams: unknown;
  let authenticateParams: unknown;
  let cancelled = false;
  let promptRequestId: JsonRpcId | undefined;

  const pendingServerRequests = new Map<string, (message: unknown) => void>();
  const write = (line: string): void => {
    process.stdout.write(line);
  };
  const respond = (id: JsonRpcId, result: unknown): void => {
    write(encodeJsonRpcResult(id, result));
  };
  const fail = (id: JsonRpcId, code: number, message: string): void => {
    write(encodeJsonRpcError(id, code, message));
  };
  const waitForServerResponse = (key: string): Promise<unknown> =>
    new Promise((resolve) => {
      pendingServerRequests.set(key, resolve);
    });

  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.length === 0) continue;
    const decoded = decodeJsonRpcLine(line);
    if (!decoded.ok) continue;
    const message = decoded.message;
    if (message.kind === 'success' || message.kind === 'error') {
      const waiter = pendingServerRequests.get(String(message.id));
      if (waiter) {
        pendingServerRequests.delete(String(message.id));
        waiter(message.kind === 'success' ? message.result : message.error);
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
      authenticateParams = message.params;
      respond(message.id, {});
      continue;
    }
    if (message.method === 'session/new') {
      emitFlood(write, sessionId);
      respond(message.id, { sessionId, models: advertisedModels() });
      continue;
    }
    if (message.method === 'session/load') {
      respond(message.id, { models: advertisedModels() });
      continue;
    }
    if (message.method === 'session/set_model') {
      setModelCalls.push(message.params);
      respond(message.id, {});
      continue;
    }
    if (message.method === 'x/received-methods') {
      respond(message.id, { receivedMethods: [...receivedMethods] });
      continue;
    }
    if (message.method === 'x/handshake') {
      respond(message.id, {
        initializeParams,
        authenticateParams,
        setModelCalls,
        spawnArgs,
        permissionResults,
        questionResults,
        exitPlanResults,
      });
      continue;
    }
    if (message.method === 'session/prompt') {
      // Keep reading stdin so permission/question/plan responses can settle.
      void handlePrompt({
        id: message.id,
        sessionId,
        promptBehavior,
        extensionPrefix,
        isCancelled: () => cancelled,
        write,
        respond,
        fail,
        waitForServerResponse,
        permissionResults,
        questionResults,
        exitPlanResults,
        setPromptRequestId: (id) => {
          promptRequestId = id;
        },
      });
      continue;
    }
    respond(message.id, {});
  }
}

async function handlePrompt(input: {
  id: JsonRpcId;
  sessionId: string;
  promptBehavior: GrokFakePrompt;
  extensionPrefix: string;
  isCancelled: () => boolean;
  write: (line: string) => void;
  respond: (id: JsonRpcId, result: unknown) => void;
  fail: (id: JsonRpcId, code: number, message: string) => void;
  waitForServerResponse: (key: string) => Promise<unknown>;
  permissionResults: unknown[];
  questionResults: unknown[];
  exitPlanResults: unknown[];
  setPromptRequestId: (id: JsonRpcId) => void;
}): Promise<void> {
  const { id, sessionId, promptBehavior, write, respond, fail } = input;
  if (promptBehavior === 'hang') {
    return;
  }
  if (promptBehavior === 'reject') {
    queueMicrotask(() => fail(id, -32000, 'prompt rejected'));
    return;
  }
  if (promptBehavior === 'rate-limit-rpc') {
    fail(id, -32003, 'rate limited native payload should not leak');
    return;
  }
  if (promptBehavior === 'wait-cancel') {
    input.setPromptRequestId(id);
    return;
  }
  if (promptBehavior === 'permission') {
    await emitPermissions(input);
  }
  if (promptBehavior === 'question') {
    input.questionResults.push(await emitQuestion(input));
  }
  if (promptBehavior === 'plan' || promptBehavior === 'plan-twice') {
    emitEnterPlanMode(write, sessionId);
    input.exitPlanResults.push(await emitExitPlan(input, '# Plan v1\n\n- step', 1));
    if (promptBehavior === 'plan-twice') {
      input.exitPlanResults.push(await emitExitPlan(input, '# Plan v1\n\n- step', 2));
    }
  }
  write(
    encodeJsonRpcNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello from grok' },
      },
    }),
  );
  if (promptBehavior === 'prompt-complete' || promptBehavior === 'rate-limit-complete') {
    write(
      encodeJsonRpcNotification(`${input.extensionPrefix}x.ai/session/prompt_complete`, {
        sessionId,
        stopReason: promptBehavior === 'rate-limit-complete' ? 'rate_limit' : 'end_turn',
      }),
    );
    return;
  }
  if (promptBehavior === 'both') {
    write(
      encodeJsonRpcNotification(`${input.extensionPrefix}x.ai/session/prompt_complete`, {
        sessionId,
        stopReason: 'end_turn',
      }),
    );
    respond(id, { stopReason: 'end_turn' });
    return;
  }
  respond(id, { stopReason: input.isCancelled() ? 'cancelled' : 'end_turn' });
}

async function emitPermissions(input: {
  sessionId: string;
  write: (line: string) => void;
  waitForServerResponse: (key: string) => Promise<unknown>;
  permissionResults: unknown[];
}): Promise<void> {
  const count = Number(process.env[GROK_FAKE_PERMISSION_COUNT_ENV] ?? '1');
  const secondCommand = process.env[GROK_FAKE_SECOND_PERMISSION_COMMAND_ENV];
  for (let index = 0; index < Math.max(1, count); index += 1) {
    const requestId = `perm-${String(index)}`;
    const pending = input.waitForServerResponse(requestId);
    const command =
      index === 1 && secondCommand ? secondCommand : index === 0 ? 'ls' : `cmd-${String(index)}`;
    input.write(
      encodeJsonRpcRequest(requestId, 'session/request_permission', {
        sessionId: input.sessionId,
        toolCall: {
          toolCallId: `tool-${String(index)}`,
          title: 'Terminal',
          kind: 'execute',
          rawInput: { command, variant: 'Bash' },
        },
        options: [
          { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
        ],
      }),
    );
    input.permissionResults.push(await pending);
  }
}

async function emitQuestion(input: {
  sessionId: string;
  extensionPrefix: string;
  write: (line: string) => void;
  waitForServerResponse: (key: string) => Promise<unknown>;
}): Promise<unknown> {
  const requestId = 'question-1';
  const pending = input.waitForServerResponse(requestId);
  input.write(
    encodeJsonRpcRequest(requestId, `${input.extensionPrefix}x.ai/ask_user_question`, {
      sessionId: input.sessionId,
      toolCallId: 'ask-1',
      mode: 'default',
      questions: [
        {
          id: 'scope',
          question: 'Which scope should Grok use?',
          options: [{ label: 'Workspace' }, { label: 'Session' }],
        },
        {
          question: 'Which changes should be included?',
          multiSelect: true,
          options: [{ label: 'Tests' }, { label: 'Docs' }],
        },
      ],
    }),
  );
  return pending;
}

function emitEnterPlanMode(write: (line: string) => void, sessionId: string): void {
  const detect = process.env[GROK_FAKE_PLAN_DETECT_ENV] ?? 'title';
  write(
    encodeJsonRpcNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'enter-plan',
        title: detect === 'title' ? 'enter_plan_mode' : 'Tool',
        status: 'inProgress',
        ...(detect === 'variant' ? { rawInput: { variant: 'EnterPlanMode' } } : {}),
      },
    }),
  );
}

async function emitExitPlan(
  input: {
    sessionId: string;
    extensionPrefix: string;
    write: (line: string) => void;
    waitForServerResponse: (key: string) => Promise<unknown>;
  },
  planContent: string,
  sequence: number,
): Promise<unknown> {
  const requestId = `exit-plan-${String(sequence)}`;
  const pending = input.waitForServerResponse(requestId);
  input.write(
    encodeJsonRpcRequest(requestId, `${input.extensionPrefix}x.ai/exit_plan_mode`, {
      sessionId: input.sessionId,
      toolCallId: 'exit-1',
      planContent,
    }),
  );
  return pending;
}

function advertisedModels(): {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string }>;
} {
  const raw = process.env[GROK_FAKE_MODELS_ENV];
  if (raw === '') {
    return { currentModelId: 'grok-build', availableModels: [] };
  }
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed) && Array.isArray(parsed.availableModels)) {
        return {
          currentModelId:
            typeof parsed.currentModelId === 'string' ? parsed.currentModelId : 'grok-build',
          availableModels: parsed.availableModels.flatMap((entry) => {
            if (!isPlainObject(entry)) return [];
            const modelId = entry.modelId;
            const name = entry.name;
            if (typeof modelId !== 'string' || typeof name !== 'string') return [];
            return [{ modelId, name }];
          }),
        };
      }
    } catch {
      return { currentModelId: 'grok-build', availableModels: [] };
    }
  }
  return {
    currentModelId: 'grok-build',
    availableModels: [
      { modelId: 'grok-build', name: 'Grok Build' },
      { modelId: 'grok-4.6', name: 'Grok 4.6' },
    ],
  };
}

function emitFlood(write: (line: string) => void, sessionId: string): void {
  const count = Number(process.env[GROK_FAKE_FLOOD_ENV] ?? '0');
  for (let index = 0; index < count; index += 1) {
    write(
      encodeJsonRpcNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `flood-${String(index)}` },
        },
      }),
    );
  }
}

function parsePromptBehavior(value: string | undefined): GrokFakePrompt {
  switch (value) {
    case 'hang':
    case 'prompt-complete':
    case 'both':
    case 'rate-limit-rpc':
    case 'rate-limit-complete':
    case 'reject':
    case 'wait-cancel':
    case 'permission':
    case 'question':
    case 'plan':
    case 'plan-twice':
    case 'complete':
      return value;
    default:
      return 'complete';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
