// Deterministic end-to-end replay runner (#116 phase 0): boots the REAL
// sidecar pipeline (SessionManager + SessionEventFlow + SessionTimeline +
// worker-backed history persistence + bridgeServer WebSocket transport) against a scripted
// provider, then measures every stage and reports against budgets.
//
// Determinism contract: same scenario + seed → identical event stream, order,
// and sizes. Wall-clock pacing and measured latencies are machine-dependent
// by design (that is what a baseline measures).

import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { McpServerConfigSchema, type McpServerConfig } from '@factory/droid-sdk';

import { SessionManager, type SessionManagerDependencies } from '../SessionManager.js';
import { HistoryPersistence } from '../HistoryPersistence.js';
import { BrowserSessionManager } from '../browser/BrowserSessionManager.js';
import { startBridgeServer } from '../bridgeServer.js';
import { hotPathMetrics, type HotPathMetricsSnapshot } from '../telemetry/hotPathMetrics.js';
import { ReservoirHistogram } from '../telemetry/histogram.js';
import { buildReplayPlan, type PerfScenarioSpec, type ReplayTurnPlan } from './scenario.js';
import { ReplayFactoryRuntime, type ReplayYieldReport } from './replayRuntime.js';
import { evaluateBudgets } from './budgets.js';
import { evaluateReplayGates } from './gates.js';
import type { ReplayReport } from './report.js';
import { acceptReplayWireMessage, messageText, type ReplayWireCursor } from './replayWire.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  type ServerWireMessage,
  type TranscriptEvent,
} from '../protocol.js';

export interface ReplayTickHelpers {
  send: (command: Parameters<SessionManager['handle']>[0]) => void;
  sessionIds: readonly (string | undefined)[];
}

export interface ReplayRunOptions {
  spec: PerfScenarioSpec;
  onWaitTick?: (helpers: ReplayTickHelpers) => void;
}

interface AppendedSample {
  at: number;
  eventTs: number;
  kind: TranscriptEvent['kind'];
  toolUseId: string | undefined;
}

const DRAIN_QUIET_MS = 350;
const OVERHEAD_ALLOWANCE_MS = 15_000;

export async function runReplay(options: ReplayRunOptions): Promise<ReplayReport> {
  const { spec, onWaitTick } = options;
  const plan = buildReplayPlan(spec);
  const home = mkdtempSync(join(tmpdir(), 'droidex-perf-replay-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  const token = `perf-${Math.random().toString(36).slice(2)}`;
  const assetToken = `perf-asset-${Math.random().toString(36).slice(2)}`;
  const providerEvents: ReplayYieldReport[] = [];
  const markerYields = new Map<string, number>();
  const appended: AppendedSample[] = [];
  const settledTurns = new Set<string>();
  const turnsBySession = new Map<number, ReplayTurnPlan[]>();
  for (const turn of plan.turns) {
    const existing = turnsBySession.get(turn.sessionIndex) ?? [];
    existing.push(turn);
    turnsBySession.set(turn.sessionIndex, existing);
  }
  // The global plan orders turns across sessions for schedule fidelity, but
  // the replay runtime selects a session's plan by prompt count, so each
  // session's list must be in strict turn order before consumption.
  for (const [index, turns] of turnsBySession) {
    turnsBySession.set(
      index,
      turns.toSorted((a, b) => a.turn - b.turn),
    );
  }

  let manager: SessionManager | null = null;
  const server = startBridgeServer({
    requestedPort: 0,
    token,
    assetToken,
    onCommand: async (command) => {
      if (!manager) throw new Error('Replay command arrived before the manager existed.');
      await manager.handle(command);
    },
  });
  await server.ready;

  const runtime = new ReplayFactoryRuntime(turnsBySession, {
    onYield: (report) => {
      providerEvents.push(report);
      if (report.marker) markerYields.set(report.marker, report.at);
    },
    onTurnSettled: (sessionIndex, turn) => {
      settledTurns.add(`${String(sessionIndex)}:${String(turn)}`);
    },
  });
  const browsers = new BrowserSessionManager({
    assetUrlFor: (path) => server.browserAssetUrl(path),
    emit: (event) => {
      server.broadcast(event);
    },
  });
  // Worker startup is a sidecar-start concern, not a steady-state settlement
  // sample. Establish the writer and its durability checkpoint before metrics
  // begin so the boundary histogram measures live orchestration behavior.
  const history = new HistoryPersistence();
  history.flushSync();
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
      return () => `perf-child-${String(++sequence)}`;
    })(),
    streamingCoalesceMs: spec.coalesceMs,
  };
  manager = new SessionManager(
    (event) => {
      server.broadcast(event);
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
  const liveManager = manager;
  hotPathMetrics.reset();
  hotPathMetrics.enable();
  hotPathMetrics.setGaugeProvider(() => liveManager.resourceCounts());

  const client = new WebSocket(
    `ws://127.0.0.1:${String(server.port)}?token=${token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}`,
  );
  const sessionIds: (string | undefined)[] = [];
  const clientOpened = new Promise<void>((resolve, reject) => {
    client.once('open', () => {
      resolve();
    });
    client.once('error', reject);
  });
  let bytesReceived = 0;
  let clientProtocolFailure: Error | null = null;
  const wireCursor: ReplayWireCursor = { generation: null, lastSeq: 0 };
  const createdWaiters: ((appSessionId: string) => void)[] = [];
  client.on('message', (raw) => {
    const data = messageText(raw);
    bytesReceived += Buffer.byteLength(data);
    let wireMessage: ServerWireMessage;
    try {
      wireMessage = JSON.parse(data) as ServerWireMessage;
      for (const event of acceptReplayWireMessage(wireMessage, wireCursor)) {
        if (event.type === 'session.created') {
          const index = numberFromClientRef(event.clientRef);
          sessionIds[index] = event.session.appSessionId;
          for (const waiter of createdWaiters.splice(0)) waiter(event.session.appSessionId);
          continue;
        }
        if (event.type === 'event.appended') {
          const { event: transcript } = event;
          appended.push({
            at: performance.timeOrigin + performance.now(),
            eventTs: transcript.ts,
            kind: transcript.kind,
            toolUseId: transcript.toolUseId,
          });
        }
      }
    } catch (error) {
      clientProtocolFailure =
        error instanceof Error ? error : new Error(`Invalid bridge message: ${String(error)}`);
      for (const waiter of createdWaiters.splice(0)) waiter('');
      return;
    }
  });
  await clientOpened;
  // Post-open transport errors (e.g. the server closing first during cleanup)
  // must stay informational; the runner's own await points own failure.
  client.on('error', () => undefined);

  const startedAt = Date.now();
  const startedPerf = performance.now();
  let failure: unknown = null;
  try {
    await withTimeout(createAndDriveSessions(), expectedWallClockMs(spec), 'replay timed out');
  } catch (error) {
    failure = error;
  }
  const durationMs = Math.round(performance.now() - startedPerf);

  // Metrics capture must never strand the server, manager, pinned HOME, or
  // temp dir: cleanup runs whether or not the snapshot succeeds.
  let sidecar: HotPathMetricsSnapshot | null = null;
  try {
    sidecar = await fetchSidecarMetrics(server.port, token);
  } catch (error) {
    if (failure === null) failure = error;
  } finally {
    await cleanup();
  }

  if (failure !== null) {
    throw failure instanceof Error ? failure : new Error(JSON.stringify(failure));
  }
  if (sidecar === null) throw new Error('Sidecar metrics snapshot was not captured.');

  return buildReport(sidecar);

  async function createAndDriveSessions(): Promise<void> {
    for (let index = 0; index < spec.sessions; index += 1) {
      const clientRef = `replay-session-${String(index)}`;
      const created = new Promise<string>((resolve) => {
        createdWaiters.push(resolve);
      });
      sendCommand(client, {
        type: 'session.create',
        clientRef,
        title: `Perf replay ${String(index)}`,
        goal: `replay session ${String(index)}`,
        sessionPurpose: 'chat',
        autonomy: 'off',
      });
      await created;
      throwIfClientProtocolFailed();
    }
    // Each session runs its turns sequentially; sessions run concurrently,
    // which is exactly the interleaved-source workload the harness measures.
    await Promise.all(
      Array.from({ length: spec.sessions }, (_, index) => driveSessionTurns(index)),
    );
    await waitForDrain();
  }

  async function driveSessionTurns(index: number): Promise<void> {
    const turns = turnsBySession.get(index) ?? [];
    for (const turn of turns) {
      const appSessionId = sessionIds[index];
      if (appSessionId === undefined)
        throw new Error(`Session ${String(index)} was never created.`);
      sendCommand(client, { type: 'session.send', appSessionId, text: turn.prompt });
      await waitFor(
        () => {
          throwIfClientProtocolFailed();
          return settledTurns.has(`${String(index)}:${String(turn.turn)}`);
        },
        expectedWallClockMs(spec),
        `turn ${String(index)}:${String(turn.turn)} never settled`,
        () => {
          onWaitTick?.({
            send: (command) => {
              sendCommand(client, command);
            },
            sessionIds,
          });
        },
      );
    }
  }

  async function waitForDrain(): Promise<void> {
    // Let the final coalesce timers flush and the socket drain.
    await sleep(spec.coalesceMs + DRAIN_QUIET_MS);
    throwIfClientProtocolFailed();
  }

  function buildReport(sidecar: HotPathMetricsSnapshot): ReplayReport {
    const appendToReceive = new ReservoirHistogram();
    const providerToReceive = new ReservoirHistogram();
    let markerSamples = 0;
    for (const sample of appended) {
      appendToReceive.add(sample.at - sample.eventTs);
      if (sample.kind === 'tool_call' || sample.kind === 'tool_result') {
        const marker = `${sample.kind === 'tool_call' ? 'call' : 'result'}:${sample.toolUseId ?? ''}`;
        const yieldedAt = markerYields.get(marker);
        if (yieldedAt !== undefined) {
          providerToReceive.add(sample.at - yieldedAt);
          markerSamples += 1;
        }
      }
    }
    const drift = driftStats();
    const client = {
      appendedReceived: appended.length,
      appendToReceiveMs: appendToReceive.stats(),
      providerToReceiveMs: providerToReceive.stats(),
      markerSamples,
      bytesReceived,
    };
    return {
      scenario: spec,
      startedAt,
      durationMs,
      providerEvents: providerEvents.length,
      client,
      drift,
      sidecar,
      budgets: evaluateBudgets(sidecar, client, spec.coalesceMs),
      gates: evaluateReplayGates(spec, sidecar, client),
      environment: {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpus: availableParallelism(),
      },
    };
  }

  function driftStats(): ReplayReport['drift'] {
    if (spec.name !== 'long-history' || appended.length < 4) return null;
    const midpoint = Math.floor(appended.length / 2);
    const firstHalf = new ReservoirHistogram();
    const secondHalf = new ReservoirHistogram();
    appended.slice(0, midpoint).forEach((sample) => {
      firstHalf.add(sample.at - sample.eventTs);
    });
    appended.slice(midpoint).forEach((sample) => {
      secondHalf.add(sample.at - sample.eventTs);
    });
    return {
      firstHalfToReceiveMs: firstHalf.stats(),
      secondHalfToReceiveMs: secondHalf.stats(),
    };
  }

  async function cleanup(): Promise<void> {
    client.close();
    try {
      await manager?.shutdown();
    } finally {
      try {
        await server.close();
      } finally {
        hotPathMetrics.disable();
        hotPathMetrics.reset();
        hotPathMetrics.clearGaugeProvider();
        // Assigning undefined would store the literal string "undefined".
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
      }
    }
  }

  function throwIfClientProtocolFailed(): void {
    if (clientProtocolFailure !== null) throw clientProtocolFailure;
  }
}

export { acceptReplayWireMessage, type ReplayWireCursor } from './replayWire.js';

function sendCommand(client: WebSocket, command: Parameters<SessionManager['handle']>[0]): void {
  client.send(JSON.stringify(command));
}

function numberFromClientRef(clientRef: string): number {
  const match = /(\d+)$/.exec(clientRef);
  return match ? Number(match[1]) : -1;
}

async function fetchSidecarMetrics(port: number, token: string): Promise<HotPathMetricsSnapshot> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/perf/metrics?token=${token}`);
  if (!response.ok) throw new Error(`Metrics endpoint returned ${String(response.status)}`);
  return (await response.json()) as HotPathMetricsSnapshot;
}

function expectedWallClockMs(spec: PerfScenarioSpec): number {
  return spec.expectedDurationMs + OVERHEAD_ALLOWANCE_MS;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
  onTick?: () => void,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    onTick?.();
    await sleep(25);
  }
}

async function withTimeout(work: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function availableParallelism(): number {
  return cpus().length;
}

function stubMcpResource(): { start(): Promise<McpServerConfig>; close(): Promise<void> } {
  const config = McpServerConfigSchema.parse({
    type: 'http',
    name: 'perf-replay-stub',
    url: 'http://127.0.0.1/replay',
  });
  return {
    start: () => Promise.resolve(config),
    close: () => Promise.resolve(),
  };
}
