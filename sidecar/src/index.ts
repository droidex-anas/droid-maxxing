import { SessionManager } from './SessionManager.js';
import { startBridgeServer } from './bridgeServer.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';
import { createSharedShutdown, SIDECAR_SHUTDOWN_BUDGET_MS } from './providers/shutdownDeadline.js';

const REQUESTED_PORT = bridgePort(process.env.BRIDGE_PORT ?? '0');
const TOKEN = requiredSecret('BRIDGE_TOKEN');
const ASSET_TOKEN = requiredSecret('BROWSER_ASSET_TOKEN');
const EXIT_ON_STDIN_CLOSE = process.env.BRIDGE_EXIT_ON_STDIN_CLOSE !== '0';

const server = startBridgeServer({
  requestedPort: REQUESTED_PORT,
  token: TOKEN,
  assetToken: ASSET_TOKEN,
  onCommand: async (command) => {
    await manager.handle(command);
  },
  getSnapshot: () => manager.runtimeSnapshot(),
});

const manager = new SessionManager(
  (event) => {
    server.broadcast(event);
  },
  {
    assetUrlFor: (filePath) => server.browserAssetUrl(filePath),
  },
);

server.ready
  .then(() => {
    hotPathMetrics.enable();
    hotPathMetrics.setGaugeProvider(() => manager.resourceCounts());
    // Stdout line consumed by the desktop supervisor to confirm readiness.
    process.stdout.write(`SIDECAR_READY ${String(server.port)}\n`);
    // Yield so the supervisor observes ready before follow-up work starts.
    setImmediate(() => {
      if (shuttingDown) return;
    });
  })
  .catch((error: unknown) => {
    console.error(
      `Sidecar bridge failed to listen: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });

let shuttingDown = false;

const triggerShutdown = createSharedShutdown(
  async (deadline) => {
    shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), deadline.remainingMs());
    forceExit.unref();
    try {
      // Keep the bridge available while manager cleanup emits final state.
      // Bridge close is bounded by the shared deadline, not a fresh relative wait.
      await manager.shutdown(deadline);
      hotPathMetrics.disable();
      await server.close(deadline);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    clearTimeout(forceExit);
    process.exit();
  },
  { durationMs: SIDECAR_SHUTDOWN_BUDGET_MS },
);

function shutdown(): Promise<void> {
  return triggerShutdown();
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
