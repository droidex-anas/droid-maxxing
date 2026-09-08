import { memo } from 'react';
import type { ModelInfo, ReasoningEffort } from '../types/bridge';
import { ModelIcon, providerOf } from './ModelIcon';

const ROW_H = 36;

export const BASE_REASONING: ReasoningEffort[] = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'dynamic',
];

/** Effort choices a row exposes: the model's supported set, or its single fixed default. */
export function effortsFor(model: ModelInfo | undefined, fallback: ReasoningEffort) {
  if (!model) return BASE_REASONING;
  const supported = model.supportedReasoningEfforts;
  if (supported?.length) return supported;
  return [model.defaultReasoningEffort ?? fallback];
}

export function stepEffort(efforts: ReasoningEffort[], current: ReasoningEffort, delta: number) {
  const idx = efforts.indexOf(current);
  const base = idx === -1 ? efforts.length - 1 : idx;
  return efforts[Math.min(efforts.length - 1, Math.max(0, base + delta))];
}

function ModelCatalogList({
  models,
  hasRealModels,
  selectedModelId,
  reasoning,
  query,
  onSelectModel,
  onSelectReasoning,
  disabled,
  reasoningLocked,
}: {
  models: ModelInfo[];
  hasRealModels: boolean;
  selectedModelId: string | undefined;
  reasoning: ReasoningEffort;
  query: string;
  onSelectModel: (modelId?: string) => void;
  onSelectReasoning: (reasoning: ReasoningEffort) => void;
  disabled: boolean;
  reasoningLocked: boolean;
}) {
  const highlightIndex = !selectedModelId
    ? 0
    : hasRealModels
      ? models.findIndex((m) => m.id === selectedModelId) + 1
      : 0;
  const pick = (modelId: string | undefined, effort?: ReasoningEffort) => {
    if (modelId !== selectedModelId) onSelectModel(modelId);
    if (effort) onSelectReasoning(effort);
  };
  const rowProps = { selectedModelId, reasoning, pick, disabled, reasoningLocked };

  return (
    <div className="mt-2 max-h-[180px] overflow-y-auto -mx-1 px-1">
      <div className="relative" role="listbox">
        <div
          aria-hidden
          className={`absolute inset-x-0 top-0 h-9 rounded-lg bg-droid-surface ring-1 ring-inset ring-droid-active pointer-events-none ${
            highlightIndex > 0 || !selectedModelId ? '' : 'opacity-0'
          }`}
          style={{
            transform: `translateY(${String(highlightIndex * ROW_H)}px)`,
            transition: 'transform .22s cubic-bezier(.16,1,.3,1), opacity .15s',
          }}
        />
        <ModelRow label="Default" {...rowProps} />
        {hasRealModels ? (
          <>
            {models.map((model) => (
              <ModelRow key={model.id} label={model.displayName} model={model} {...rowProps} />
            ))}
            {models.length === 0 && (
              <div className="px-2 py-3 text-[10px] text-droid-text-muted text-center">
                No matches for “{query}”
              </div>
            )}
          </>
        ) : (
          <div className="px-2 py-3 text-[10px] text-droid-text-muted text-center">
            Loading models…
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ModelCatalogList);

function ModelRow({
  label,
  model,
  selectedModelId,
  reasoning,
  pick,
  disabled,
  reasoningLocked,
}: {
  label: string;
  model?: ModelInfo;
  selectedModelId: string | undefined;
  reasoning: ReasoningEffort;
  pick: (modelId: string | undefined, effort?: ReasoningEffort) => void;
  disabled: boolean;
  reasoningLocked: boolean;
}) {
  const id = model?.id;
  const selected = id === selectedModelId;
  const efforts = effortsFor(model, reasoning);
  const shown = selected
    ? reasoning
    : (model?.defaultReasoningEffort ?? efforts[efforts.length - 1]);
  const current = efforts.indexOf(shown);
  const canStep = efforts.length > 1 && !reasoningLocked;
  const lockTitle = reasoningLocked ? 'Change the child model to adjust reasoning.' : undefined;

  const arrow = (delta: -1 | 1) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={delta < 0 ? 'Lower reasoning effort' : 'Raise reasoning effort'}
      disabled={disabled || !canStep}
      onClick={(e) => {
        e.stopPropagation();
        pick(id, stepEffort(efforts, shown, delta));
      }}
      className={`w-4 shrink-0 text-[11px] text-droid-text-secondary hover:text-droid-text transition-opacity ${
        selected && canStep ? '' : 'opacity-0 pointer-events-none'
      }`}
    >
      {delta < 0 ? '←' : '→'}
    </button>
  );

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) pick(id);
      }}
      className={`relative flex items-center gap-2.5 h-9 px-2.5 rounded-lg select-none ${
        disabled
          ? 'cursor-not-allowed opacity-50'
          : selected
            ? 'cursor-default'
            : 'cursor-pointer hover:bg-droid-surface/60'
      }`}
    >
      <span
        className={`w-4 h-4 shrink-0 flex items-center justify-center ${selected ? '' : 'opacity-70'}`}
      >
        <ModelIcon provider={providerOf(model)} size={16} />
      </span>
      <span
        className={`min-w-0 flex-1 text-[12.5px] truncate ${
          selected ? 'text-droid-text' : 'text-droid-text-secondary'
        }`}
      >
        {label}
      </span>
      {arrow(-1)}
      <span className="flex gap-[3px] shrink-0" title={lockTitle}>
        {efforts.map((effort, i) => {
          const filled = i <= current;
          return (
            <button
              key={effort}
              type="button"
              tabIndex={-1}
              aria-label={`${label}: ${effort}`}
              disabled={disabled || reasoningLocked}
              onClick={(e) => {
                e.stopPropagation();
                pick(id, effort);
              }}
              className={`w-[9px] h-[9px] rounded-[2px] ${
                filled
                  ? selected
                    ? 'bg-droid-accent'
                    : 'bg-droid-text-muted'
                  : selected
                    ? 'bg-[#333]'
                    : 'bg-droid-active'
              } ${disabled || reasoningLocked ? 'cursor-not-allowed' : ''}`}
              style={{
                transition: 'background .2s, transform .25s cubic-bezier(.34,1.56,.64,1)',
                transitionDelay: `${String(i * 25)}ms`,
                transform: filled && selected ? 'scale(1.08)' : undefined,
              }}
            />
          );
        })}
      </span>
      {arrow(1)}
      <span
        className={`w-[52px] shrink-0 text-[11.5px] capitalize truncate ${
          selected ? 'text-droid-text' : 'text-droid-text-muted'
        }`}
      >
        {shown}
      </span>
    </div>
  );
}
