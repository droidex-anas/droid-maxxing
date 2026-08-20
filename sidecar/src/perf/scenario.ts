// Deterministic replay scenarios for the perf harness (#116 phase 0).
//
// A scenario fully determines the provider workload: how many sessions stream
// concurrently, the event mix, inter-arrival schedule, payload sizes, and the
// sidecar's streaming coalesce window. Given the same seed the generated plan
// is byte-identical, so before/after comparisons across code changes measure
// the code, not the workload.

import type { DroidStreamEvent } from '@factory/droid-sdk';

export interface PerfScenarioSpec {
  name: string;
  description: string;
  seed: number;
  sessions: number;
  turnsPerSession: number;
  deltasPerTurn: number;
  // Scheduled provider events per second, per session.
  eventsPerSecond: number;
  // Character range of each streamed text delta.
  deltaChars: { min: number; max: number };
  // Insert a tool_call/tool_result marker pair every N deltas. Markers are
  // never coalesced, so they yield exact provider-to-wire end-to-end samples.
  toolMarkerEvery: number;
  // SessionTimeline streamingCoalesceMs forwarded into the sidecar wiring.
  coalesceMs: number;
  // Wall-clock target derived from the schedule (informational).
  expectedDurationMs: number;
}

export interface ReplayStep {
  atMs: number;
  event: DroidStreamEvent;
  marker: string | null;
}

export interface ReplayTurnPlan {
  sessionIndex: number;
  turn: number;
  prompt: string;
  steps: ReplayStep[];
}

export interface ReplayPlan {
  spec: PerfScenarioSpec;
  turns: ReplayTurnPlan[];
}

// `name` stays overridable so harness tests can run a scaled-down spec under
// the long-history identity (drift stats key off the scenario name).
type ScenarioOverrides = Partial<Omit<PerfScenarioSpec, 'description'>>;

function scenario(
  name: string,
  description: string,
  overrides: ScenarioOverrides = {},
): PerfScenarioSpec {
  const spec: PerfScenarioSpec = {
    name,
    description,
    seed: 11,
    sessions: 1,
    turnsPerSession: 1,
    deltasPerTurn: 60,
    eventsPerSecond: 20,
    deltaChars: { min: 24, max: 96 },
    toolMarkerEvery: 20,
    coalesceMs: 35,
    expectedDurationMs: 0,
    ...overrides,
  };
  spec.expectedDurationMs = expectedDurationMs(spec);
  return spec;
}

export function expectedDurationMs(spec: PerfScenarioSpec): number {
  const eventsPerTurn = spec.deltasPerTurn + markerPairs(spec.deltasPerTurn, spec.toolMarkerEvery);
  const eventsPerSession = eventsPerTurn * spec.turnsPerSession;
  return Math.ceil((eventsPerSession / spec.eventsPerSecond) * 1_000) + spec.coalesceMs + 250;
}

// Values include undefined so lookups stay honest at runtime: an unknown
// scenario name must fail fast instead of narrowing to a phantom builder.
export const PERF_SCENARIOS: Record<string, (() => PerfScenarioSpec) | undefined> = {
  smoke: () => scenario('smoke', 'One session, one short turn; sanity-checks the harness itself.'),
  streaming: () =>
    scenario('streaming', 'Sustained single-session token streaming.', {
      seed: 23,
      turnsPerSession: 3,
      deltasPerTurn: 400,
      eventsPerSecond: 100,
    }),
  'multi-agent': () =>
    scenario('multi-agent', 'Eight sessions streaming concurrently (interleaved sources).', {
      seed: 37,
      sessions: 8,
      turnsPerSession: 2,
      deltasPerTurn: 200,
      eventsPerSecond: 25,
    }),
  'long-history': () =>
    scenario('long-history', 'Thousands of accumulated events; compares early vs late latency.', {
      seed: 51,
      turnsPerSession: 4,
      deltasPerTurn: 1_500,
      eventsPerSecond: 300,
      toolMarkerEvery: 50,
    }),
};

function scenarioBuilderByName(name: string): (() => PerfScenarioSpec) | undefined {
  return PERF_SCENARIOS[name];
}

function availableScenarioNames(): string[] {
  return Object.keys(PERF_SCENARIOS).sort();
}

export function resolveScenario(name: string, overrides: ScenarioOverrides = {}): PerfScenarioSpec {
  const builder = scenarioBuilderByName(name);
  if (builder === undefined) {
    throw new Error(
      `Unknown scenario "${name}". Available: ${availableScenarioNames().join(', ')}.`,
    );
  }
  const spec = builder();
  const merged = { ...spec, ...overrides };
  merged.expectedDurationMs = expectedDurationMs(merged);
  return merged;
}

export function buildReplayPlan(spec: PerfScenarioSpec): ReplayPlan {
  const random = mulberry32(spec.seed);
  const turns: ReplayTurnPlan[] = [];
  for (let sessionIndex = 0; sessionIndex < spec.sessions; sessionIndex += 1) {
    for (let turn = 0; turn < spec.turnsPerSession; turn += 1) {
      turns.push(buildTurn(spec, random, sessionIndex, turn));
    }
  }
  // Interleaved sessions emit on the same global timeline, so order turns by
  // their first step to keep the merged schedule faithful to `atMs`.
  turns.sort((a, b) => (a.steps.at(0)?.atMs ?? 0) - (b.steps.at(0)?.atMs ?? 0));
  return { spec, turns };
}

function buildTurn(
  spec: PerfScenarioSpec,
  random: () => number,
  sessionIndex: number,
  turn: number,
): ReplayTurnPlan {
  const messageId = `s${String(sessionIndex)}-t${String(turn)}`;
  const steps: ReplayStep[] = [];
  const intervalMs = 1_000 / spec.eventsPerSecond;
  let toolCounter = 0;
  for (let delta = 0; delta < spec.deltasPerTurn; delta += 1) {
    // Tiny deterministic jitter (±20% of one interval) keeps the schedule off
    // a perfectly periodic grid without changing the event count or order.
    const jitter = (random() - 0.5) * 0.4 * intervalMs;
    const atMs = Math.max(0, Math.round(delta * intervalMs + jitter));
    const chars = Math.round(
      spec.deltaChars.min + random() * (spec.deltaChars.max - spec.deltaChars.min),
    );
    const isThinking = random() < 0.15;
    steps.push({
      atMs,
      event: {
        type: isThinking ? 'thinking_text_delta' : 'assistant_text_delta',
        messageId,
        blockIndex: 0,
        text: deltaText(random, chars),
      },
      marker: null,
    });
    if ((delta + 1) % spec.toolMarkerEvery === 0 && delta + 1 < spec.deltasPerTurn) {
      toolCounter += 1;
      const toolUseId = `${messageId}-tool-${String(toolCounter)}`;
      const toolName = toolCounter % 2 === 0 ? 'Read' : 'Bash';
      steps.push({
        atMs: atMs + Math.round(intervalMs / 3),
        event: {
          type: 'tool_call',
          toolUse: {
            type: 'tool_use',
            id: toolUseId,
            name: toolName,
            input: { path: `/tmp/replay-${String(toolCounter)}.txt` },
          },
        },
        marker: `call:${toolUseId}`,
      });
      steps.push({
        atMs: atMs + Math.round((2 * intervalMs) / 3),
        event: {
          type: 'tool_result',
          toolName,
          toolUseId,
          content: deltaText(random, 160),
          isError: false,
        },
        marker: `result:${toolUseId}`,
      });
    }
  }
  // Marker offsets plus delta jitter can push a marker past the next delta's
  // slot; the generator paces against a monotonic schedule, so order by time.
  steps.sort((a, b) => a.atMs - b.atMs);
  return {
    sessionIndex,
    turn,
    prompt: `replay turn ${String(turn)}`,
    steps,
  };
}

const WORDS = [
  'streaming',
  'transcript',
  'session',
  'provider',
  'normalize',
  'persist',
  'transport',
  'coalesce',
  'latency',
  'budget',
  'baseline',
  'measure',
  'renderer',
  'sidecar',
  'event',
];

function deltaText(random: () => number, chars: number): string {
  let text = '';
  while (text.length < chars) {
    text += WORDS[Math.floor(random() * WORDS.length)];
    if (text.length < chars) text += ' ';
  }
  return text.slice(0, Math.max(1, chars));
}

function markerPairs(deltas: number, every: number): number {
  if (every <= 0) return 0;
  return Math.max(0, Math.floor(deltas / every) - (deltas % every === 0 ? 1 : 0));
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
