import type { ShutdownDeadline } from '../shutdownDeadline.js';
import {
  ContextBreakdownResultSchema,
  DroidSession,
  type DroidStreamEvent,
  type MessageOptions,
} from '@factory/droid-sdk';

type FactorySessionMethods = Pick<
  DroidSession,
  | 'sessionId'
  | 'initResult'
  | 'interrupt'
  | 'updateSettings'
  | 'enterSpecMode'
  | 'compactSession'
  | 'close'
  | 'onNotification'
  | 'getContextStats'
  | 'forkSession'
  | 'renameSession'
  | 'getRewindInfo'
  | 'executeRewind'
  | 'listTools'
  | 'listSkills'
  | 'listMcpServers'
  | 'listMcpTools'
  | 'addMcpServer'
  | 'removeMcpServer'
  | 'toggleMcpServer'
  | 'authenticateMcpServer'
>;

export type FactorySession = Omit<FactorySessionMethods, 'close'> & {
  close(deadline?: ShutdownDeadline): Promise<void>;
  stream(
    prompt: string,
    options: MessageOptions & { includePartialMessages: true },
  ): AsyncGenerator<DroidStreamEvent, void, undefined>;
};

export interface DroidSessionExtension {
  compactSession: FactorySession['compactSession'];
  getContextStats: FactorySession['getContextStats'];
  updateSettings: FactorySession['updateSettings'];
  enterSpecMode: FactorySession['enterSpecMode'];
  forkSession: FactorySession['forkSession'];
  renameSession: FactorySession['renameSession'];
  getRewindInfo: FactorySession['getRewindInfo'];
  executeRewind: FactorySession['executeRewind'];
  listTools: FactorySession['listTools'];
  listSkills: FactorySession['listSkills'];
  listMcpServers: FactorySession['listMcpServers'];
  listMcpTools: FactorySession['listMcpTools'];
  addMcpServer: FactorySession['addMcpServer'];
  removeMcpServer: FactorySession['removeMcpServer'];
  toggleMcpServer: FactorySession['toggleMcpServer'];
  authenticateMcpServer: FactorySession['authenticateMcpServer'];
  readContextBreakdown(): Promise<unknown>;
  replaceNativeSession(session: FactorySession, kind: 'resume_state' | 'native_replacement'): void;
}

export function createDroidSessionExtension(
  requireFactory: () => FactorySession,
  replaceNativeSession: (
    session: FactorySession,
    kind: 'resume_state' | 'native_replacement',
  ) => void,
): DroidSessionExtension {
  return {
    compactSession: (params) => requireFactory().compactSession(params),
    getContextStats: () => requireFactory().getContextStats(),
    updateSettings: (params) => requireFactory().updateSettings(params),
    enterSpecMode: (params) => requireFactory().enterSpecMode(params),
    forkSession: () => requireFactory().forkSession(),
    renameSession: (params) => requireFactory().renameSession(params),
    getRewindInfo: (params) => requireFactory().getRewindInfo(params),
    executeRewind: (params) => requireFactory().executeRewind(params),
    listTools: (params) => requireFactory().listTools(params),
    listSkills: () => requireFactory().listSkills(),
    listMcpServers: () => requireFactory().listMcpServers(),
    listMcpTools: () => requireFactory().listMcpTools(),
    addMcpServer: (params) => requireFactory().addMcpServer(params),
    removeMcpServer: (params) => requireFactory().removeMcpServer(params),
    toggleMcpServer: (params) => requireFactory().toggleMcpServer(params),
    authenticateMcpServer: (params) => requireFactory().authenticateMcpServer(params),
    readContextBreakdown: () => readContextBreakdown(requireFactory()),
    replaceNativeSession,
  };
}

export async function readContextBreakdown(session: FactorySession): Promise<unknown> {
  try {
    const exposed = session as unknown as { getContextBreakdown?: () => Promise<unknown> };
    if (typeof exposed.getContextBreakdown === 'function') {
      return await exposed.getContextBreakdown();
    }
    const client = (
      session as unknown as {
        _client?: {
          _sessionRpcWithoutParams?: (method: string, schema: unknown) => Promise<unknown>;
        };
      }
    )._client;
    if (!client?._sessionRpcWithoutParams) return undefined;
    return await client._sessionRpcWithoutParams(
      'droid.get_context_breakdown',
      ContextBreakdownResultSchema,
    );
  } catch {
    return undefined;
  }
}
