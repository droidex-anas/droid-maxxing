import {
  configureAutomationManager,
  type AutomationManager,
} from './automations/AutomationManager.js';
import { SessionManager } from './SessionManager.js';
import { startBridgeServer } from './bridgeServer.js';
import { droidexUserDataDir } from './droidexPaths.js';
import { shutdownSidecar } from './shutdown.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';
import { startRemoteAdmin } from './remote/admin.js';

const REQUESTED_PORT = bridgePort(process.env.BRIDGE_PORT ?? '0');
const TOKEN = requiredSecret('BRIDGE_TOKEN');
const ASSET_TOKEN = requiredSecret('BROWSER_ASSET_TOKEN');
const EXIT_ON_STDIN_CLOSE = process.env.BRIDGE_EXIT_ON_STDIN_CLOSE !== '0';

let automationManager: AutomationManager | null = null;
let mobile: Awaited<ReturnType<typeof startRemoteAdmin>> | undefined;
let mobileStartup: Promise<void> | undefined;

const server = startBridgeServer({
  requestedPort: REQUESTED_PORT,
  token: TOKEN,
  assetToken: ASSET_TOKEN,
  onCommand: async (command) => {
    if (automationManager && (await automationManager.handleBridgeCommand(command))) return;
    await manager.handle(command);
  },
  getSnapshot: () => manager.runtimeSnapshot(),
});

const manager = new SessionManager(
  (event) => {
    if (automationManager) {
      void automationManager.observeSessionEvent(event).catch((error: unknown) => {
        console.error('Automation lifecycle observer failed', error);
      });
    }
    server.broadcast(event);
    mobile?.observe(event);
  },
  { assetUrlFor: (filePath) => server.browserAssetUrl(filePath) },
);

automationManager = configureAutomationManager({
  dataDir: droidexUserDataDir(),
  emit: (event) => {
    server.broadcast(event);
  },
  launchSession: (command) => manager.handle(command),
  closeSession: (appSessionId) => manager.handle({ type: 'session.close', appSessionId }),
  resolveSessionContext: (appSessionId) => manager.automationSessionContext(appSessionId),
  validateSelection: (modelId, reasoningEffort) =>
    manager.validateAutomationSelection(modelId, reasoningEffort),
});

let shuttingDown = false;

server.ready
  .then(() => {
    hotPathMetrics.enable();
    hotPathMetrics.setGaugeProvider(() => manager.resourceCounts());
    // Stdout line consumed by the desktop supervisor to confirm readiness.
    process.stdout.write(`SIDECAR_READY ${String(server.port)}\n`);
    mobileStartup = startRemoteAdmin(droidexUserDataDir(), manager).then(async (control) => {
      mobile = control;
      if (shuttingDown) await control.close();
    }).catch(() => {
      console.error('Mobile access could not start. The desktop remains available.');
    });
    // Yield so the supervisor observes ready before the search isolate starts.
    setImmediate(() => {
      if (shuttingDown) return;
      manager.startSessionFileServing();
    });
  })
  .catch((error: unknown) => {
    console.error(
      `Sidecar bridge failed to listen: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();
  try {
    try {
      await mobileStartup;
      await mobile?.close();
    } catch (error) {
      console.error('Mobile shutdown failed; continuing desktop cleanup.', error);
      process.exitCode = 1;
    }
    await shutdownSidecar({
      shutdownSessions: () => manager.shutdown(),
      shutdownAutomations: async () => {
        await automationManager?.shutdown();
      },
      disableMetrics: () => {
        hotPathMetrics.disable();
      },
      closeBridge: () => server.close(),
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  clearTimeout(forceExit);
  process.exit();
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
