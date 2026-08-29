import { McpServerConfigSchema } from '@factory/droid-sdk';

import { BrowserSessionManager } from '../sidecar/src/browser/BrowserSessionManager.ts';
import { startBridgeServer } from '../sidecar/src/bridgeServer.ts';
import { DroidMcpConfiguration } from '../sidecar/src/DroidMcpConfiguration.ts';
import { loadFactoryMcpServers } from '../sidecar/src/FactoryMcpConfig.ts';
import { buildReplayPlan, resolveScenario, type ReplayTurnPlan } from '../sidecar/src/perf/scenario.ts';
import { ReplayFactoryRuntime, ReplayFactorySession } from '../sidecar/src/perf/replayRuntime.ts';
import type { RuntimeHandlers } from '../sidecar/src/providers/droid/DroidModeMapping.ts';
import type { FactoryRuntime } from '../sidecar/src/providers/droid/DroidProviderAdapter.ts';
import { SessionManager, type SessionManagerDependencies } from '../sidecar/src/SessionManager.ts';
import { hotPathMetrics } from '../sidecar/src/telemetry/hotPathMetrics.ts';

const REQUESTED_PORT = bridgePort(process.env.BRIDGE_PORT ?? '0');
const TOKEN = requiredSecret('BRIDGE_TOKEN');
const ASSET_TOKEN = requiredSecret('BROWSER_ASSET_TOKEN');
const EXIT_ON_STDIN_CLOSE = process.env.BRIDGE_EXIT_ON_STDIN_CLOSE !== '0';
const SCENARIO = process.env.GUI_BENCH_REPLAY_SCENARIO ?? 'streaming';

const spec = resolveScenario(SCENARIO);
const plan = buildReplayPlan(spec);
const turnsBySession = new Map<number, ReplayTurnPlan[]>();
for (const turn of plan.turns) {
  const existing = turnsBySession.get(turn.sessionIndex) ?? [];
  existing.push(turn);
  turnsBySession.set(turn.sessionIndex, existing);
}
for (const [index, turns] of turnsBySession) {
  turnsBySession.set(
    index,
    turns.toSorted((a, b) => a.turn - b.turn),
  );
}

const hooks = {
  onYield: () => undefined,
  onTurnSettled: () => undefined,
};

class GuiBenchReplayRuntime extends ReplayFactoryRuntime implements FactoryRuntime {
  loadSession(
    providerSessionId: string,
    handlers?: RuntimeHandlers,
  ): Promise<ReplayFactorySession> {
    const childTurns = turnsBySession.get(1) ?? turnsBySession.get(0) ?? [];
    const session = new ReplayFactorySession(providerSessionId, handlers ?? {}, childTurns, hooks);
    return Promise.resolve(session);
  }
}

const runtime = new GuiBenchReplayRuntime(turnsBySession, hooks);

const server = startBridgeServer({
  requestedPort: REQUESTED_PORT,
  token: TOKEN,
  assetToken: ASSET_TOKEN,
  onCommand: async (command) => {
    await manager.handle(command);
  },
  getSnapshot: () => manager.runtimeSnapshot(),
});

const browsers = new BrowserSessionManager({
  assetUrlFor: (filePath) => server.browserAssetUrl(filePath),
  emit: (event) => {
    server.broadcast(event);
  },
});

const dependencies: SessionManagerDependencies = {
  runtime,
  browsers,
  createLocalMcpResource: () => stubMcpResource(),
  mcpConfiguration: new DroidMcpConfiguration(),
  loadConfiguredMcpServers: loadFactoryMcpServers,
  streamingCoalesceMs: spec.coalesceMs,
};

const manager = new SessionManager(
  (event) => {
    server.broadcast(event);
  },
  { dependencies },
);

server.ready
  .then(() => {
    hotPathMetrics.enable();
    hotPathMetrics.setGaugeProvider(() => manager.resourceCounts());
    process.stdout.write(`SIDECAR_READY ${String(server.port)}\n`);
  })
  .catch((error: unknown) => {
    console.error(
      `Sidecar bridge failed to listen: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();
  try {
    await manager.shutdown();
    hotPathMetrics.disable();
    await server.close();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  clearTimeout(forceExit);
  process.exit();
}

function stubMcpResource() {
  const config = McpServerConfigSchema.parse({
    type: 'http',
    name: 'gui-bench-replay-stub',
    url: 'http://127.0.0.1/gui-bench-replay',
  });
  return {
    start: () => Promise.resolve(config),
    close: () => Promise.resolve(),
  };
}

function requiredSecret(name: 'BRIDGE_TOKEN' | 'BROWSER_ASSET_TOKEN'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function bridgePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`BRIDGE_PORT must be an integer from 0 to 65535; received ${value}.`);
  }
  return port;
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
if (EXIT_ON_STDIN_CLOSE) {
  process.stdin.resume();
  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
}
