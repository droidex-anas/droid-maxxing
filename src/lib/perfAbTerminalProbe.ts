import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';

export const TERMINAL_FLOOD_CHUNKS = 1_000;
export const TERMINAL_CHUNK = 'x'.repeat(64);

export async function measureTerminalFlood(treeRoot: string): Promise<AbProbeMetric> {
  const terminalPath = join(treeRoot, 'electron/terminal.cjs');
  if (!existsSync(terminalPath)) {
    return metric('terminal.deliveriesPerFlood', NaN, 'messages', 'electron/terminal.cjs missing');
  }
  const requireFromTree = createRequire(terminalPath);
  const terminal = requireFromTree(terminalPath) as TerminalModule;
  const portPath = join(dirname(terminalPath), 'terminalPort.cjs');
  let registryMod: RegistryModule | null = null;
  if (existsSync(portPath)) {
    registryMod = requireFromTree(portPath) as RegistryModule;
  } else if (terminal.createTerminalSubscriptionRegistry) {
    registryMod = terminal;
  }
  if (!registryMod) {
    return metric(
      'terminal.deliveriesPerFlood',
      NaN,
      'messages',
      'no subscription registry on this tree',
    );
  }
  const { manager, instances } = createTerminalFixture(terminal);
  const terminalId = (await manager.create({ appSessionId: 'session-1', cwd: '/tmp' })).id;
  const timers: { callback: () => void }[] = [];
  const registry = registryMod.createTerminalSubscriptionRegistry(manager, {
    setTimeout: (callback: () => void) => {
      const handle = { callback };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle: { callback: () => void }) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const sender = fakeSender();
  const port = fakePort();
  try {
    registry.subscribe(sender, terminalId, port);
  } catch {
    registry.subscribe(sender, terminalId);
  }
  for (let index = 0; index < TERMINAL_FLOOD_CHUNKS; index += 1) {
    instances[0]?.emitData(TERMINAL_CHUNK);
  }
  for (const timer of timers.splice(0)) timer.callback();
  const dataDeliveries = port.posted.filter((payload) => payload.kind === 'data').length;
  const ipcDeliveries = sender.sends.filter((send) => send.payload.kind === 'data').length;
  const deliveries = dataDeliveries + ipcDeliveries;
  manager.kill(terminalId);
  return metric(
    'terminal.deliveriesPerFlood',
    deliveries,
    'messages',
    existsSync(portPath)
      ? 'MessagePort data posts after a 1000-chunk flood'
      : 'ipc sender.send data events after a 1000-chunk flood',
  );
}

function createTerminalFixture(terminal: TerminalModule) {
  const instances: { emitData: (data: string) => void }[] = [];
  const manager = terminal.createTerminalManager({
    platform: 'darwin',
    randomId: (() => {
      let id = 0;
      return () => `probe-terminal-${String(++id)}`;
    })(),
    fsp: {
      stat: () => Promise.resolve({ isDirectory: () => true }),
      realpath: (cwd: string) => Promise.resolve(cwd),
    },
    resolveShell: () => ({ file: '/bin/sh', args: [] }),
    buildEnv: () => ({ TERM: 'xterm-256color' }),
    loadPty: () => ({
      spawn() {
        let dataHandler: (data: string) => void = () => undefined;
        const instance = {
          writes: [],
          onData(handler: (data: string) => void) {
            dataHandler = handler;
          },
          onExit() {
            return undefined;
          },
          write() {
            return undefined;
          },
          resize() {
            return undefined;
          },
          kill() {
            return undefined;
          },
          emitData(data: string) {
            dataHandler(data);
          },
        };
        instances.push(instance);
        return instance;
      },
    }),
  });
  return { manager, instances };
}

function fakeSender() {
  const sender = new EventEmitter() as EventEmitter & {
    id: number;
    destroyed: boolean;
    isDestroyed: () => boolean;
    send: (channel: string, payload: { kind?: string }) => void;
    sends: { channel: string; payload: { kind?: string } }[];
  };
  sender.id = 1;
  sender.destroyed = false;
  sender.isDestroyed = () => sender.destroyed;
  sender.sends = [];
  sender.send = (channel, payload) => {
    sender.sends.push({ channel, payload });
  };
  return sender;
}

function fakePort() {
  const posted: { kind?: string }[] = [];
  return {
    posted,
    closed: false,
    start() {
      return undefined;
    },
    postMessage(data: { kind?: string }) {
      posted.push(data);
    },
    close() {
      this.closed = true;
    },
    on() {
      return undefined;
    },
    removeListener() {
      return undefined;
    },
  };
}

function metric(id: string, value: number, unit: string, method: string): AbProbeMetric {
  return { id, value, unit, method };
}

interface AbProbeMetric {
  id: string;
  value: number;
  unit: string;
  method: string;
}

interface TerminalModule {
  createTerminalManager: (options: unknown) => {
    create: (options: { appSessionId: string; cwd: string }) => Promise<{ id: string }>;
    kill: (id: string) => void;
  };
  createTerminalSubscriptionRegistry?: RegistryModule['createTerminalSubscriptionRegistry'];
}

interface RegistryModule {
  createTerminalSubscriptionRegistry: (
    manager: unknown,
    options?: unknown,
  ) => {
    subscribe: (sender: unknown, terminalId: string, port?: unknown) => void;
  };
}
