// Settings → Configuration → Transcript: the three-stop tool-activity density
// slider plus the inline-diffs switch, with a live preview rendered through the
// same transcript row components the chat feed uses. Both settings are
// render-only feed props, so changes apply live without a restart.

import { useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import type { TranscriptEvent } from '../types/bridge';
import type { FileChange } from '../lib/diff';
import type { ToolActivityDensity, ToolActivitySettings } from '../lib/toolActivity';
import { SettingRow } from './settingsKit';
import { Switch } from './Switch';
import { DiffGroup, ToolGroupItem } from './transcript/groups';

const DENSITY_STOPS: { value: ToolActivityDensity; label: string; hint: string }[] = [
  { value: 'compact', label: 'Compact', hint: 'One line per run; expand it for the tools.' },
  { value: 'balanced', label: 'Balanced', hint: 'One line per tool; expand a line for output.' },
  { value: 'detailed', label: 'Detailed', hint: 'Commands and output stay visible.' },
];

const PREVIEW_BASE = {
  appSessionId: 'tool-activity-preview',
  sourceSessionId: 'tool-activity-preview',
  role: 'primary' as const,
  ts: 0,
};

const PREVIEW_TOOL_EVENTS: TranscriptEvent[] = [
  {
    id: 'preview-read-call',
    ...PREVIEW_BASE,
    kind: 'tool_call',
    toolName: 'Read',
    toolArgs: { file_path: 'src/app.tsx' },
  },
  {
    id: 'preview-read-result',
    ...PREVIEW_BASE,
    kind: 'tool_result',
    text: 'export function App() { … }',
  },
  {
    id: 'preview-grep-call',
    ...PREVIEW_BASE,
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'density' },
  },
  {
    id: 'preview-grep-result',
    ...PREVIEW_BASE,
    kind: 'tool_result',
    text: 'src/lib/toolActivity.ts:7',
  },
  {
    id: 'preview-exec-call',
    ...PREVIEW_BASE,
    kind: 'tool_call',
    toolName: 'Bash',
    toolArgs: { command: 'npm test' },
  },
  {
    id: 'preview-exec-result',
    ...PREVIEW_BASE,
    kind: 'tool_result',
    text: '✓ 42 tests passed in 3.2s',
  },
];

const PREVIEW_DIFF: { event: TranscriptEvent; change: FileChange }[] = [
  {
    event: { id: 'preview-diff', ...PREVIEW_BASE, kind: 'tool_call', toolName: 'Edit' },
    change: {
      path: 'src/app.tsx',
      verb: 'edit',
      added: 2,
      removed: 1,
      ops: [
        { type: 'ctx', text: 'export function App() {' },
        { type: 'del', text: '  return <OldShell />;' },
        { type: 'add', text: '  return <NewShell density={density} />;' },
        { type: 'ctx', text: '}' },
      ],
    },
  },
];

export function ToolActivitySettings() {
  const dispatch = useStoreDispatch();
  const settings = useStoreSelector((s) => s.toolActivity);
  const update = (patch: Partial<ToolActivitySettings>) => {
    dispatch({ type: 'SET_TOOL_ACTIVITY', settings: { ...settings, ...patch } });
  };
  const stopIndex = Math.max(
    0,
    DENSITY_STOPS.findIndex((s) => s.value === settings.density),
  );
  const current = DENSITY_STOPS[stopIndex];

  return (
    <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-8">
      <div className="px-4 py-3.5">
        <div className="text-[13px] text-droid-text">Tool activity</div>
        <div className="text-[11px] text-droid-text-muted mt-0.5">
          How much working detail the transcript shows. {current.hint}
        </div>
        <input
          type="range"
          min={0}
          max={DENSITY_STOPS.length - 1}
          step={1}
          value={stopIndex}
          aria-label="Tool activity density"
          aria-valuetext={current.label}
          onChange={(e) => {
            const stop = DENSITY_STOPS.at(Number(e.target.value));
            if (stop) update({ density: stop.value });
          }}
          className="mt-3 h-1 w-full cursor-pointer rounded-full"
          style={{ accentColor: 'var(--droid-accent)' }}
        />
        <div className="mt-1 flex justify-between">
          {DENSITY_STOPS.map((stop) => (
            <button
              key={stop.value}
              type="button"
              onClick={() => {
                update({ density: stop.value });
              }}
              className={`text-[11px] transition-colors ${
                stop.value === settings.density
                  ? 'font-medium text-droid-text'
                  : 'text-droid-text-muted hover:text-droid-text-secondary'
              }`}
            >
              {stop.label}
            </button>
          ))}
        </div>
      </div>
      <SettingRow
        label="Inline code diffs"
        description="Expand file edits directly in the transcript."
      >
        <Switch
          label="Inline code diffs"
          checked={settings.inlineDiffs}
          onChange={(checked) => {
            update({ inlineDiffs: checked });
          }}
        />
      </SettingRow>
      <div className="px-4 py-3.5">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-droid-text-muted">
          Preview
        </div>
        {/* Remount on any change so disclosure state re-initializes from the
            new defaults and the preview always reflects the pending setting. */}
        <div
          key={`${settings.density}:${String(settings.inlineDiffs)}`}
          className="space-y-3 rounded-lg border border-droid-border bg-droid-bg/60 p-3"
        >
          <ToolGroupItem events={PREVIEW_TOOL_EVENTS} density={settings.density} />
          <DiffGroup changes={PREVIEW_DIFF} inlineDiffs={settings.inlineDiffs} />
        </div>
      </div>
    </div>
  );
}
