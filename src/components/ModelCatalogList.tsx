import { memo, useCallback, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ModelInfo, ReasoningEffort } from '../types/bridge';
import { ModelIcon, providerOf } from './ModelIcon';

const ROW_H = 36;
const VISIBLE_H = 180;

/** The catalog entry Droid CLI falls back to when no model is chosen. */
export function defaultModelOf(models: ModelInfo[]) {
  return models.find((m) => m.isDefault && !m.isCustom);
}

/** Effort choices a row exposes: the model's supported set, or its single fixed default. */
export function effortsFor(model: ModelInfo | undefined, fallback: ReasoningEffort) {
  const supported = model?.supportedReasoningEfforts;
  if (supported?.length) return supported;
  return [model?.defaultReasoningEffort ?? fallback];
}

export function stepEffort(efforts: ReasoningEffort[], current: ReasoningEffort, delta: number) {
  const idx = efforts.indexOf(current);
  const base = idx === -1 ? efforts.length - 1 : idx;
  return efforts[Math.min(efforts.length - 1, Math.max(0, base + delta))];
}

type Pick = (modelId: string | undefined) => void;

function ModelCatalogList({
  models,
  defaultModel,
  hasRealModels,
  selectedModelId,
  reasoning,
  query,
  onSelectModel,
  disabled,
  reasoningLocked,
  showDefault = true,
}: {
  models: ModelInfo[];
  defaultModel: ModelInfo | undefined;
  hasRealModels: boolean;
  selectedModelId: string | undefined;
  reasoning: ReasoningEffort;
  query: string;
  onSelectModel: (modelId?: string) => void;
  disabled: boolean;
  reasoningLocked: boolean;
  showDefault?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = hasRealModels ? models : [];
  const firstModelIndex = showDefault ? 1 : 0;
  // -1 when the active model is filtered out: nothing is highlighted then.
  const selectedIndex = selectedModelId
    ? (() => {
        const index = rows.findIndex((model) => model.id === selectedModelId);
        return index < 0 ? -1 : index + firstModelIndex;
      })()
    : showDefault
      ? 0
      : -1;

  const virtualizer = useVirtualizer({
    count: rows.length + firstModelIndex,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 4,
    initialRect: { width: 0, height: VISIBLE_H },
    initialOffset: Math.max(0, selectedIndex * ROW_H - VISIBLE_H / 2 + ROW_H / 2),
  });

  useEffect(() => {
    if (selectedIndex > 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedIndex, virtualizer]);

  const latest = useRef({ selectedModelId, onSelectModel });
  latest.current = { selectedModelId, onSelectModel };
  const pick = useCallback<Pick>((modelId) => {
    const cur = latest.current;
    if (modelId !== cur.selectedModelId) cur.onSelectModel(modelId);
  }, []);

  const rowProps = { pick, disabled, reasoningLocked };

  return (
    <div ref={scrollRef} className="mt-2 max-h-[180px] overflow-y-auto -mx-1 px-1">
      <div
        role="listbox"
        aria-label="Models"
        className="relative"
        style={{ height: `${String(virtualizer.getTotalSize())}px` }}
      >
        <div
          aria-hidden
          className={`absolute inset-x-0 top-0 h-9 rounded-lg bg-droid-surface ring-1 ring-inset ring-droid-active pointer-events-none ${
            selectedIndex < 0 ? 'opacity-0' : ''
          }`}
          style={{
            transform: `translateY(${String(Math.max(0, selectedIndex) * ROW_H)}px)`,
            transition: 'transform .22s cubic-bezier(.16,1,.3,1), opacity .15s',
          }}
        />
        {virtualizer.getVirtualItems().map((item) => {
          const isDefaultRow = showDefault && item.index === 0;
          const model = isDefaultRow ? undefined : rows[item.index - firstModelIndex];
          const selected = item.index === selectedIndex;
          return (
            <div
              key={model?.id ?? 'default'}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${String(item.start)}px)` }}
            >
              {isDefaultRow ? (
                <ModelRow
                  label={defaultModel ? `Default · ${defaultModel.displayName}` : 'Default'}
                  model={defaultModel}
                  isDefaultRow
                  selected={selected}
                  reasoning={selected ? reasoning : undefined}
                  {...rowProps}
                />
              ) : (
                <ModelRow
                  label={model?.displayName ?? ''}
                  model={model}
                  selected={selected}
                  reasoning={selected ? reasoning : undefined}
                  {...rowProps}
                />
              )}
            </div>
          );
        })}
      </div>
      {!hasRealModels && (
        <div className="px-2 py-3 text-[12px] text-droid-text-muted text-center">
          Loading models…
        </div>
      )}
      {hasRealModels && models.length === 0 && (
        <div className="px-2 py-3 text-[12px] text-droid-text-muted text-center">
          No matches for “{query}”
        </div>
      )}
    </div>
  );
}

export default memo(ModelCatalogList);

const ModelRow = memo(function ModelRow({
  label,
  model,
  isDefaultRow = false,
  selected,
  reasoning,
  pick,
  disabled,
  reasoningLocked,
}: {
  label: string;
  model?: ModelInfo;
  isDefaultRow?: boolean;
  selected: boolean;
  /** Only set on the selected row; other rows show their model's default. */
  reasoning?: ReasoningEffort;
  pick: Pick;
  disabled: boolean;
  reasoningLocked: boolean;
}) {
  const id = isDefaultRow ? undefined : model?.id;
  const fallback = model?.defaultReasoningEffort ?? reasoning ?? 'medium';
  const efforts = effortsFor(model, fallback);
  const shown = reasoning ?? model?.defaultReasoningEffort ?? efforts[efforts.length - 1];
  const current = efforts.indexOf(shown);

  return (
    <div
      role="option"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) pick(id);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!disabled) pick(id);
      }}
      title={reasoningLocked ? `${label} · Change the child model to adjust reasoning.` : label}
      className={`group relative flex items-center gap-2.5 h-9 px-2.5 rounded-lg select-none ${
        disabled
          ? 'cursor-not-allowed opacity-50'
          : selected
            ? 'cursor-default'
            : 'cursor-pointer hover:bg-droid-surface'
      }`}
    >
      <span
        className={`w-4 h-4 shrink-0 flex items-center justify-center ${selected ? '' : 'opacity-70'}`}
      >
        <ModelIcon provider={providerOf(model)} size={16} />
      </span>
      <span
        className={`min-w-0 flex-1 text-[13px] truncate ${
          selected ? 'text-droid-text' : 'text-droid-text-secondary'
        }`}
      >
        {label}
      </span>
      {/* Effort reads out over the name rather than reserving width from it, so
          the name keeps the full row and never reflows when the meter appears. */}
      <span
        className={`absolute right-2 top-0 h-full flex items-center gap-2 pl-6 pointer-events-none ${
          selected ? 'opacity-100' : 'opacity-0'
        } ${disabled ? '' : 'group-hover:opacity-100'}`}
        style={{
          background: 'linear-gradient(to right, transparent, var(--droid-surface) 1.5rem)',
          transition: 'opacity .15s',
        }}
      >
        <span className="flex gap-[3px]">
          {efforts.map((effort, i) => (
            <span
              key={effort}
              className={`w-[9px] h-[9px] rounded-[2px] ${
                i <= current
                  ? selected
                    ? 'bg-droid-accent'
                    : 'bg-droid-text-muted'
                  : 'bg-droid-active'
              }`}
              style={{ transition: 'background .2s' }}
            />
          ))}
        </span>
        <span
          className={`text-[12px] capitalize ${selected ? 'text-droid-text' : 'text-droid-text-muted'}`}
        >
          {shown}
        </span>
      </span>
    </div>
  );
});
