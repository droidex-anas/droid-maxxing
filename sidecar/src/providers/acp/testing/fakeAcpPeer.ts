import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  ACP_MAX_INBOUND_LINE_BYTES,
  decodeJsonRpcLine,
  encodeJsonRpcError,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeJsonRpcResult,
  isJsonRpcId,
  type JsonRpcId,
} from '../acpJsonRpc.js';
import { ACP_STDERR_TAIL_BYTES } from '../acpProcess.js';

export const ACP_FAKE_PEER_ENV = 'DROIDEX_ACP_FAKE_PEER';
export const ACP_FAKE_BEHAVIOR_ENV = 'DROIDEX_ACP_FAKE_BEHAVIOR';
export const ACP_FAKE_SESSION_ID_ENV = 'DROIDEX_ACP_FAKE_SESSION_ID';

export type FakeAcpPeerBehavior =
  | 'handshake'
  | 'hang-prompt'
  | 'crash-on-prompt'
  | 'eof-on-prompt'
  | 'oversized-line'
  | 'malformed-json'
  | 'invalid-utf8'
  | 'out-of-order'
  | 'server-request-zero-id'
  | 'server-request-string-id'
  | 'foreign-session-update'
  | 'stderr-flood'
  | 'ignore-sigterm'
  | 'unsolicited-notification'
  | 'auth-fail';

export interface AcpSpawnOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function fakeAcpPeerPath(): string {
  return fileURLToPath(new URL('./fakeAcpPeer.ts', import.meta.url));
}

export function fakeAcpPeerSpawn(behavior: FakeAcpPeerBehavior = 'handshake'): AcpSpawnOptions {
  return {
    command: process.execPath,
    args: ['--import', 'tsx', fakeAcpPeerPath()],
    env: {
      ...process.env,
      [ACP_FAKE_PEER_ENV]: '1',
      [ACP_FAKE_BEHAVIOR_ENV]: behavior,
      [ACP_FAKE_SESSION_ID_ENV]: process.env[ACP_FAKE_SESSION_ID_ENV] ?? 'mock-session-1',
    },
  };
}

if (process.env[ACP_FAKE_PEER_ENV] === '1') {
  void runFakeAcpPeer();
}

async function runFakeAcpPeer(): Promise<void> {
  const behavior = parseBehavior(process.env[ACP_FAKE_BEHAVIOR_ENV]);
  const sessionId = process.env[ACP_FAKE_SESSION_ID_ENV] || 'mock-session-1';
  const receivedMethods: string[] = [];
  const extensionBuffer: Array<{ id: JsonRpcId; method: string; params: unknown }> = [];
  let promptCount = 0;

  if (behavior === 'ignore-sigterm') {
    process.on('SIGTERM', () => undefined);
    process.on('SIGINT', () => undefined);
  }

  if (behavior === 'stderr-flood') {
    process.stderr.write('S'.repeat(ACP_STDERR_TAIL_BYTES * 2));
  }

  if (behavior === 'oversized-line') {
    process.stdout.write(`${'x'.repeat(ACP_MAX_INBOUND_LINE_BYTES + 1)}\n`);
    return;
  }
  if (behavior === 'malformed-json') {
    process.stdout.write('{not-json\n');
    return;
  }
  if (behavior === 'invalid-utf8') {
    process.stdout.write(Buffer.from([0xff, 0x0a]));
    return;
  }

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

  const handleServerResponse = (id: JsonRpcId, payload: unknown): boolean => {
    const waiter = pendingServerRequests.get(idKey(id));
    if (!waiter) {
      return false;
    }
    pendingServerRequests.delete(idKey(id));
    waiter(payload);
    return true;
  };

  const waitForClientResponse = (id: JsonRpcId): Promise<unknown> =>
    new Promise((resolve) => {
      pendingServerRequests.set(idKey(id), resolve);
    });

  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    const decoded = decodeJsonRpcLine(line);
    if (!decoded.ok) {
      continue;
    }
    const message = decoded.message;
    if ((message.kind === 'success' || message.kind === 'error') && isJsonRpcId(message.id)) {
      handleServerResponse(message.id, message);
      continue;
    }
    if (message.kind !== 'request' && message.kind !== 'notification') {
      continue;
    }

    if (message.kind === 'notification') {
      continue;
    }

    receivedMethods.push(message.method);

    if (message.method === 'initialize') {
      respond(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      continue;
    }
    if (message.method === 'authenticate') {
      if (behavior === 'auth-fail') {
        fail(message.id, -32000, 'unauthorized');
        continue;
      }
      respond(message.id, {});
      continue;
    }
    if (message.method === 'session/new') {
      respond(message.id, { sessionId, receivedMethods: [...receivedMethods] });
      continue;
    }
    if (message.method === 'session/load') {
      respond(message.id, { receivedMethods: [...receivedMethods] });
      continue;
    }
    if (message.method === 'session/prompt') {
      promptCount += 1;
      void handlePrompt({
        behavior,
        sessionId,
        requestId: message.id,
        promptCount,
        write,
        respond,
        waitForClientResponse,
      });
      continue;
    }
    if (message.method === 'x/received-methods') {
      respond(message.id, { receivedMethods: [...receivedMethods] });
      continue;
    }
    if (message.method.startsWith('x/')) {
      if (behavior === 'out-of-order') {
        extensionBuffer.push({ id: message.id, method: message.method, params: message.params });
        if (extensionBuffer.length >= 2) {
          for (let index = extensionBuffer.length - 1; index >= 0; index -= 1) {
            const pending = extensionBuffer[index];
            if (!pending) continue;
            respond(pending.id, { echoedMethod: pending.method, echoedParams: pending.params });
          }
          extensionBuffer.length = 0;
        }
        continue;
      }
      if (behavior === 'unsolicited-notification') {
        write(
          encodeJsonRpcNotification('session/update', {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
          }),
        );
      }
      respond(message.id, { echoedMethod: message.method, echoedParams: message.params });
      continue;
    }

    respond(message.id, {});
  }
}

async function handlePrompt(input: {
  behavior: FakeAcpPeerBehavior;
  sessionId: string;
  requestId: JsonRpcId;
  promptCount: number;
  write: (line: string) => void;
  respond: (id: JsonRpcId, result: unknown) => void;
  waitForClientResponse: (id: JsonRpcId) => Promise<unknown>;
}): Promise<void> {
  if (input.behavior === 'hang-prompt') {
    return;
  }
  if (input.behavior === 'crash-on-prompt') {
    process.exit(7);
  }
  if (input.behavior === 'eof-on-prompt') {
    process.stdout.end();
    return;
  }

  if (input.behavior === 'foreign-session-update') {
    input.write(
      encodeJsonRpcNotification('session/update', {
        sessionId: input.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'root' } },
      }),
    );
    input.write(
      encodeJsonRpcNotification('session/update', {
        sessionId: 'mock-child-session-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child' } },
      }),
    );
    input.respond(input.requestId, { stopReason: 'end_turn' });
    return;
  }

  if (
    input.behavior === 'server-request-zero-id' ||
    input.behavior === 'server-request-string-id'
  ) {
    const serverId: JsonRpcId = input.behavior === 'server-request-zero-id' ? 0 : 'perm-1';
    input.write(
      encodeJsonRpcRequest(serverId, 'session/request_permission', {
        sessionId: input.sessionId,
        toolCall: { toolCallId: 'tool-1', title: 'Allow mock action' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      }),
    );
    const reply = await input.waitForClientResponse(serverId);
    const echoed = echoIdFromReply(reply, serverId);
    input.respond(input.requestId, echoed);
    return;
  }

  input.write(
    encodeJsonRpcNotification('session/update', {
      sessionId: input.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    }),
  );
  input.respond(input.requestId, { stopReason: 'end_turn', promptCount: input.promptCount });
}

function echoIdFromReply(
  reply: unknown,
  expected: JsonRpcId,
): {
  echoedId: JsonRpcId | null;
  echoedIdType: string;
  matched: boolean;
} {
  if (!isPlainObject(reply)) {
    return { echoedId: null, echoedIdType: 'missing', matched: false };
  }
  const kind = typeof reply.kind === 'string' ? reply.kind : undefined;
  const id = 'id' in reply ? reply.id : undefined;
  if (!isJsonRpcId(id)) {
    return { echoedId: null, echoedIdType: typeof id, matched: false };
  }
  return {
    echoedId: id,
    echoedIdType: typeof id,
    matched: id === expected && typeof id === typeof expected && kind === 'success',
  };
}

function parseBehavior(value: string | undefined): FakeAcpPeerBehavior {
  switch (value) {
    case 'hang-prompt':
    case 'crash-on-prompt':
    case 'eof-on-prompt':
    case 'oversized-line':
    case 'malformed-json':
    case 'invalid-utf8':
    case 'out-of-order':
    case 'server-request-zero-id':
    case 'server-request-string-id':
    case 'foreign-session-update':
    case 'stderr-flood':
    case 'ignore-sigterm':
    case 'unsolicited-notification':
    case 'auth-fail':
    case 'handshake':
      return value;
    default:
      return 'handshake';
  }
}

function idKey(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${String(id)}` : `s:${id}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
