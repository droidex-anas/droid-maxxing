import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServerConfigSchema, type McpServerConfig } from '@factory/droid-sdk';

import { BrowserSessionManager } from '../browser/BrowserSessionManager.js';
import { HistoryPersistence } from '../HistoryPersistence.js';
import { SessionManager, type SessionManagerDependencies } from '../SessionManager.js';
import { hotPathMetrics } from '../telemetry/hotPathMetrics.js';
import { evaluateReplayGates } from './gates.js';
import type { ReplayReport } from './report.js';
import { ReplayFactoryRuntime } from './replayRuntime.js';
import type { ReplayTickHelpers } from './runner.js';
import type { PerfScenarioSpec } from './scenario.js';

export function sessionSwitchTick(spec: PerfScenarioSpec): (helpers: ReplayTickHelpers) => void {
  let remaining = spec.switchCount;
  let next = 0;
  return (helpers) => {
    if (remaining <= 0) return;
    const appSessionId = helpers.sessionIds[next % helpers.sessionIds.length];
    next += 1;
    if (appSessionId === undefined) return;
    helpers.send({ type: 'session.loadHistory', appSessionId, limit: 40 });
    remaining -= 1;
  };
}

export async function runSoak(spec: PerfScenarioSpec): Promise<ReplayReport> {
  const home = mkdtempSync(join(tmpdir(), 'droidex-perf-soak-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const startedAt = Date.now();
  const startedPerf = performance.now();
  const events: { type: string; session?: { appSessionId: string } }[] = [];
  const runtime = new ReplayFactoryRuntime(new Map(), {
    onYield: () => undefined,
    onTurnSettled: () => undefined,
  });
  const history = new HistoryPersistence();
  history.flushSync();
  const browsers = new BrowserSessionManager({
    assetUrlFor: (path) => `http://127.0.0.1/soak/${path}`,
    emit: () => undefined,
  });
  const dependencies: SessionManagerDependencies = {
    runtime,
    history,
    browsers,
    createLocalMcpResource: () => stubMcpResource(),
    mcpConfiguration: {
      add: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    loadConfiguredMcpServers: () => [],
    nextChildSessionId: (() => {
      let sequence = 0;
      return () => `soak-child-${String(++sequence)}`;
    })(),
    streamingCoalesceMs: spec.coalesceMs,
  };
  const manager = new SessionManager(
    (event) => {
      events.push(event);
    },
    {
      dependencies,
      initialModels: [
        {
          id: 'model-default',
          displayName: 'Default',
          isCustom: false,
          maxContextTokens: 1_000_000,
        },
      ],
    },
  );
  hotPathMetrics.reset();
  hotPathMetrics.enable();
  hotPathMetrics.enableEventLoop();
  hotPathMetrics.setGaugeProvider(() => manager.resourceCounts());

  try {
    for (let cycle = 0; cycle < spec.soakCycles; cycle += 1) {
      const clientRef = `soak-${String(cycle)}`;
      await manager.handle({
        type: 'session.create',
        clientRef,
        title: `Soak ${String(cycle)}`,
        goal: `soak ${String(cycle)}`,
        sessionPurpose: 'chat',
        autonomy: 'off',
      });
      const created = events.find(
        (event) => event.type === 'session.created' && 'session' in event,
      );
      const appSessionId = created?.session?.appSessionId;
      if (!appSessionId) throw new Error(`Soak cycle ${String(cycle)} never created a session.`);
      await manager.handle({ type: 'session.close', appSessionId });
      events.length = 0;
    }
    const sidecar = hotPathMetrics.snapshot();
    const client = {
      appendedReceived: 0,
      appendToReceiveMs: { count: 0 },
      providerToReceiveMs: { count: 0 },
      firstTokenMs: { count: 0 },
      markerSamples: 0,
      firstTokenSamples: 0,
      bytesReceived: 0,
    };
    return {
      scenario: spec,
      startedAt,
      durationMs: Math.round(performance.now() - startedPerf),
      providerEvents: 0,
      client,
      drift: null,
      sidecar,
      budgets: { results: [], allMeasuredPassed: true },
      gates: evaluateReplayGates({ ...spec, sessions: 0 }, sidecar, client),
      environment: {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpus: 0,
      },
    };
  } finally {
    await manager.shutdown();
    hotPathMetrics.disable();
    hotPathMetrics.reset();
    hotPathMetrics.clearGaugeProvider();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function stubMcpResource(): { start(): Promise<McpServerConfig>; close(): Promise<void> } {
  const config = McpServerConfigSchema.parse({
    type: 'http',
    name: 'perf-soak-stub',
    url: 'http://127.0.0.1/soak',
  });
  return {
    start: () => Promise.resolve(config),
    close: () => Promise.resolve(),
  };
}
