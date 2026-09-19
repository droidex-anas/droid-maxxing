import { join } from 'node:path';
import { ProjectService } from './projects/ProjectService.js';
import { ProjectStore } from './projects/store.js';
import { ProjectSessions } from './projects/sessions.js';
import { createProjectCommandHandler } from './projects/bridge.js';
import {
  configureAutomationManager,
  type AutomationManager,
} from './automations/AutomationManager.js';
import { SessionManager } from './SessionManager.js';
import { startBridgeServer } from './bridgeServer.js';
import { droidexUserDataDir } from './droidexPaths.js';
import { shutdownSidecar } from './shutdown.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

const REQUESTED_PORT = bridgePort(process.env.BRIDGE_PORT ?? '0');
const TOKEN = requiredSecret('BRIDGE_TOKEN');
const ASSET_TOKEN = requiredSecret('BROWSER_ASSET_TOKEN');
const EXIT_ON_STDIN_CLOSE = process.env.BRIDGE_EXIT_ON_STDIN_CLOSE !== '0';

let automationManager: AutomationManager | null = null;
let projects: ProjectService | undefined;
let projectSessions: ProjectSessions | undefined;

const server = startBridgeServer({
  requestedPort: REQUESTED_PORT,
  token: TOKEN,
  assetToken: ASSET_TOKEN,
  onCommand: async (command) => {
    if (command.type === 'session.interrupt' || command.type === 'session.close') {
      // Invalidate automatic work immediately; never delay the user's Stop for disk IO.
      void projects?.pauseForSession(command.appSessionId).catch(reportProjectError);
    }
    if (await handleProjectCommand(command)) return;
    if (automationManager && (await automationManager.handleBridgeCommand(command))) return;
    await manager.handle(command);
  },
  getSnapshot: () => manager.runtimeSnapshot(),
});

const manager = new SessionManager(
  (event) => {
    projectSessions?.observe(event);
    if (projects) void projects.observe(event).catch(reportProjectError);
    if (automationManager) {
      void automationManager.observeSessionEvent(event).catch((error: unknown) => {
        console.error('Automation lifecycle observer failed', error);
      });
    }
    server.broadcast(event);
  },
  {
    assetUrlFor: (filePath) => server.browserAssetUrl(filePath),
    beforeFirstTurn: async (session, clientRef) => {
      await projectSessions?.beforeFirstTurn(session, clientRef);
    },
    onSessionAvailable: (appSessionId) => {
      projects?.sessionAvailable(appSessionId);
      void automationManager?.observeSessionAvailability(appSessionId).catch((error: unknown) => {
        console.error('Automation availability observer failed', error);
      });
    },
    onScheduledCapacityChanged: () => {
      projects?.capacityChanged();
      void automationManager?.observeSchedulingCapacity().catch((error: unknown) => {
        console.error('Automation scheduling capacity observer failed', error);
      });
    },
  },
);

projectSessions = new ProjectSessions(manager);
const projectsReady = ProjectService.open(
  projectSessions,
  new ProjectStore(join(droidexUserDataDir(), 'projects.json')),
  (event) => server.broadcast(event),
).then((service) => {
  projects = service;
  if (shuttingDown) service.close();
  return service;
});
void projectsReady.catch(reportProjectError);
const handleProjectCommand = createProjectCommandHandler(projectsReady, (event) =>
  server.broadcast(event),
);

function reportProjectError(error: unknown): void {
  server.broadcast({
    type: 'error',
    code: 'project.failed',
    message: error instanceof Error ? error.message : String(error),
  });
}

automationManager = configureAutomationManager({
  dataDir: droidexUserDataDir(),
  emit: (event) => {
    server.broadcast(event);
  },
  launchSession: (command) => manager.handle(command),
  deliverMessage: (id, prompt, isCurrent) => manager.deliverScheduledMessage(id, prompt, isCurrent),
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
  projects?.close();
  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();
  try {
    // Sessions close first so the automation store records their final run state
    // before it flushes. Bridge close is bounded and flushes its ordered queue
    // after shutdown.
    await shutdownSidecar({
      shutdownSessions: () => manager.shutdown(),
      shutdownAutomations: async () => {
        try {
          await automationManager?.shutdown();
        } finally {
          const service = await projectsReady.catch(() => undefined);
          await service?.flush();
        }
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
