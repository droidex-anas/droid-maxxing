export type MetricClass = 'ab' | 'candidate';

export interface MetricDefinition {
  id: string;
  class: MetricClass;
  unit: string;
  // Why this metric can or cannot produce a baseline number on origin/main.
  availability: string;
}

export const METRIC_CATALOG: readonly MetricDefinition[] = [
  {
    id: 'bundle.initialJsBytes',
    class: 'ab',
    unit: 'bytes',
    availability: 'Both refs emit dist/index.html + assets after vite build.',
  },
  {
    id: 'bundle.initialCssBytes',
    class: 'ab',
    unit: 'bytes',
    availability: 'Both refs emit an entry CSS asset after vite build.',
  },
  {
    id: 'bundle.totalJsBytes',
    class: 'ab',
    unit: 'bytes',
    availability: 'Both refs emit JS chunks under dist/assets.',
  },
  {
    id: 'feed.mountedRowsAt10k',
    class: 'ab',
    unit: 'rows',
    availability:
      'Counts the production mounted window. Trees without a virtualizer are 1:1 with retained rows.',
  },
  {
    id: 'feed.rowVisitsPerTailDeltaAt10k',
    class: 'ab',
    unit: 'rows',
    availability: 'Same mounted-window rule: visits equal mounted rows on each tree.',
  },
  {
    id: 'feed.projectionMsPerDelta',
    class: 'ab',
    unit: 'ms',
    availability:
      'Uses the tree’s production projector when present, otherwise buildGroupedFeed on both refs.',
  },
  {
    id: 'feed.eventsRebuiltPerDelta',
    class: 'ab',
    unit: 'events',
    availability:
      'Incremental projector reports rebuilt visible events; full rebuilds report the whole transcript.',
  },
  {
    id: 'markdown.perDeltaRenderMs',
    class: 'ab',
    unit: 'ms',
    availability: 'Both refs export src/components/Markdown.tsx and render with react-markdown.',
  },
  {
    id: 'terminal.deliveriesPerFlood',
    class: 'ab',
    unit: 'messages',
    availability:
      'Uses each tree’s own output path: sender.send on main, MessagePort batches when terminalPort exists.',
  },
  {
    id: 'sidecar.eventReductionRatio',
    class: 'candidate',
    unit: 'ratio',
    availability:
      'Requires the phase-1 ordered batcher; origin/main has no batch coalescing pipeline.',
  },
  {
    id: 'sidecar.pendingEventsMax',
    class: 'candidate',
    unit: 'events',
    availability: 'Transport queue accounting exists only on the ordered pipeline.',
  },
  {
    id: 'sidecar.pendingEstimatedBytesMax',
    class: 'candidate',
    unit: 'bytes',
    availability: 'Transport queue accounting exists only on the ordered pipeline.',
  },
  {
    id: 'sidecar.persistenceBoundaryP95Ms',
    class: 'candidate',
    unit: 'ms',
    availability: 'Write-behind durability histograms exist only on this branch.',
  },
  {
    id: 'sidecar.markerLoss',
    class: 'candidate',
    unit: 'count',
    availability: 'Replay harness and sequenced batches do not exist on origin/main.',
  },
  {
    id: 'sidecar.orderErrors',
    class: 'candidate',
    unit: 'count',
    availability: 'Sequence-gap detection is part of the phase-1 wire protocol.',
  },
  {
    id: 'sidecar.livePrimarySessions',
    class: 'candidate',
    unit: 'sessions',
    availability: 'Resource gauges and the replay/soak harness exist only on this branch.',
  },
  {
    id: 'sidecar.rssBytes',
    class: 'candidate',
    unit: 'bytes',
    availability:
      'Recorded on this branch only; noisy on shared runners so it is never a hard gate.',
  },
  {
    id: 'sidecar.cpuUserMs',
    class: 'candidate',
    unit: 'ms',
    availability:
      'Recorded on this branch only; noisy on shared runners so it is never a hard gate.',
  },
];

export function metricClass(id: string): MetricClass | undefined {
  return METRIC_CATALOG.find((metric) => metric.id === id)?.class;
}
