import { ChevronDown, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ModelCatalogList from '../../components/ModelCatalogList';
import { ModelIcon, providerOf } from '../../components/ModelIcon';
import { listModels } from '../../lib/commands';
import type { ModelInfo, ReasoningEffort } from '../../types/bridge';
import { AnchoredPopover } from './AnchoredPopover';
import { reasoningForModel } from './modelSelection';

const ACCENT = 'var(--droid-accent)';
const accentMix = (pct: number) =>
  `color-mix(in srgb, var(--droid-accent) ${String(pct)}%, transparent)`;

// Tall enough for the reasoning row, a useful slice of the catalog, and the
// footer; the popover still clamps it to the room the viewport actually has.
const PANEL_MAX_HEIGHT = 560;

type ModelCategory = 'core' | 'factory' | 'custom';

const CATEGORY_LABEL: Record<ModelCategory, string> = {
  core: 'Droid core',
  factory: 'Factory',
  custom: 'Custom',
};

const BASE_REASONING: ReasoningEffort[] = [
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

export function AutomationModelPicker({
  models,
  modelId,
  reasoningEffort,
  onChange,
}: {
  models: ModelInfo[];
  modelId: string | null;
  reasoningEffort: ReasoningEffort | null;
  onChange: (selection: { modelId: string; reasoningEffort: ReasoningEffort }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ModelCategory | 'all'>('all');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selectedModel = models.find((model) => model.id === modelId);
  const selectedReasoning = reasoningForModel(selectedModel, reasoningEffort);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCategory('all');
  }, []);

  useEffect(() => {
    if (models.length === 0) listModels();
  }, [models.length]);

  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return models.filter((model) => {
      if (category !== 'all' && categoryOf(model) !== category) return false;
      if (!normalized) return true;
      return (
        model.displayName.toLowerCase().includes(normalized) ||
        model.id.toLowerCase().includes(normalized) ||
        (model.provider ?? '').toLowerCase().includes(normalized)
      );
    });
  }, [category, models, query]);

  const categoryCounts = useMemo(() => {
    const counts: Record<ModelCategory, number> = { core: 0, factory: 0, custom: 0 };
    for (const model of models) counts[categoryOf(model)] += 1;
    return counts;
  }, [models]);

  const reasoningOptions = reasoningOptionsForModel(selectedModel, selectedReasoning);
  const label =
    selectedModel?.displayName ?? (models.length === 0 ? 'Loading models…' : 'Choose model');

  const selectModel = (nextModelId?: string) => {
    if (!nextModelId) return;
    const nextModel = models.find((model) => model.id === nextModelId);
    if (!nextModel) return;
    onChange({
      modelId: nextModel.id,
      reasoningEffort: reasoningForModel(nextModel, selectedReasoning),
    });
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Choose automation model and reasoning"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        className={`inline-flex max-w-[270px] items-center gap-2 rounded-xl border px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:border-droid-border-hover ${
          open
            ? 'border-droid-border-hover bg-droid-elevated'
            : 'border-transparent hover:border-droid-border hover:bg-droid-elevated/70'
        }`}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ModelIcon provider={providerOf(selectedModel)} size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-droid-text">{label}</span>
          <span className="block text-[10.5px] capitalize text-droid-text-muted">
            {selectedModel ? `${selectedReasoning} reasoning` : 'Select from your model catalog'}
          </span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <AnchoredPopover
        open={open}
        anchorRef={buttonRef}
        onClose={close}
        width={390}
        align="end"
        maximumHeight={PANEL_MAX_HEIGHT}
        ariaLabel="Select automation model and reasoning"
      >
        {/* `inherit` keeps this column inside the height the popover resolved,
            so the reasoning row, catalog, and Done control stay reachable. */}
        <div className="flex min-h-0 flex-col" style={{ maxHeight: 'inherit' }}>
          <div className="flex items-start justify-between gap-3 border-b border-droid-border/70 px-4 pb-3 pt-3.5">
            <div>
              <div className="text-[11px] font-medium text-droid-text-secondary">
                Model and reasoning
              </div>
              <div className="mt-0.5 text-[10px] text-droid-text-muted">
                Uses the same live catalog as the chat composer
              </div>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close model selector"
              title="Close model selector"
              className="rounded-lg p-1.5 text-droid-text-muted transition-colors hover:bg-droid-surface hover:text-droid-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-4 pb-2 pt-3.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-droid-text-muted">
                  Reasoning
                </span>
                <span className="text-[10.5px] font-medium capitalize" style={{ color: ACCENT }}>
                  {selectedReasoning}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 rounded-xl border border-droid-border bg-droid-bg/65 p-1">
                {reasoningOptions.map((reasoning) => {
                  const selected = reasoning === selectedReasoning;
                  return (
                    <button
                      key={reasoning}
                      type="button"
                      onClick={() => {
                        if (!selectedModel) return;
                        onChange({ modelId: selectedModel.id, reasoningEffort: reasoning });
                      }}
                      disabled={!selectedModel}
                      className={`relative rounded-lg px-2.5 py-1.5 text-[10.5px] capitalize outline-none transition-colors focus-visible:ring-1 focus-visible:ring-droid-border-hover disabled:cursor-not-allowed disabled:opacity-40 ${
                        selected ? 'text-droid-text' : 'text-droid-text-muted hover:text-droid-text'
                      }`}
                      style={
                        selected
                          ? {
                              backgroundColor: accentMix(13),
                              boxShadow: `inset 0 0 0 1px ${accentMix(35)}`,
                            }
                          : undefined
                      }
                    >
                      {reasoning}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="px-4 pb-3 pt-2">
              <label className="flex h-9 items-center gap-2 rounded-xl border border-droid-border bg-droid-bg/65 px-3 text-droid-text-muted transition-colors focus-within:border-droid-border-hover">
                <Search className="h-3.5 w-3.5 shrink-0" />
                <input
                  autoFocus
                  value={query}
                  aria-label="Search models"
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  placeholder="Search models"
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-droid-text outline-none placeholder:text-droid-text-muted/65"
                />
              </label>

              <div className="mt-2 flex flex-wrap gap-1">
                <CategoryButton
                  label="All"
                  active={category === 'all'}
                  onClick={() => {
                    setCategory('all');
                  }}
                />
                {(Object.keys(CATEGORY_LABEL) as ModelCategory[]).map((value) =>
                  categoryCounts[value] > 0 ? (
                    <CategoryButton
                      key={value}
                      label={CATEGORY_LABEL[value]}
                      count={categoryCounts[value]}
                      active={category === value}
                      onClick={() => {
                        setCategory(value);
                      }}
                    />
                  ) : null,
                )}
              </div>

              <ModelCatalogList
                models={filteredModels}
                hasRealModels={models.length > 0}
                selectedModelId={modelId ?? undefined}
                query={query}
                onSelectModel={selectModel}
                disabled={false}
                showDefault={false}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-droid-border/70 px-4 py-3">
            <span className="min-w-0 truncate text-[10.5px] text-droid-text-muted">
              {selectedModel
                ? `${selectedModel.displayName} · ${selectedReasoning} reasoning`
                : 'Choose a model to continue'}
            </span>
            <button
              type="button"
              onClick={close}
              disabled={!selectedModel}
              className="rounded-lg bg-droid-text px-3 py-1.5 text-[11px] font-medium text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              Done
            </button>
          </div>
        </div>
      </AnchoredPopover>
    </>
  );
}

function CategoryButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-[10.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-droid-border-hover ${
        active
          ? 'bg-droid-surface text-droid-text'
          : 'text-droid-text-muted hover:bg-droid-surface/60 hover:text-droid-text'
      }`}
    >
      {label}
      {count !== undefined ? ` ${String(count)}` : ''}
    </button>
  );
}

function categoryOf(model: ModelInfo): ModelCategory {
  if (model.isCustom || model.id.startsWith('custom:')) return 'custom';
  const provider = (model.provider ?? '').toLowerCase();
  if (provider === 'droid-core' || model.displayName.toLowerCase().startsWith('droid core')) {
    return 'core';
  }
  return 'factory';
}

function reasoningOptionsForModel(
  model: ModelInfo | undefined,
  current: ReasoningEffort,
): ReasoningEffort[] {
  if (!model) return BASE_REASONING;
  if (model.supportedReasoningEfforts?.length) return model.supportedReasoningEfforts;
  if (model.defaultReasoningEffort) return [model.defaultReasoningEffort];
  return BASE_REASONING.includes(current) ? BASE_REASONING : [current, ...BASE_REASONING];
}
