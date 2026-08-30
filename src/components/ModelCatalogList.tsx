import { memo } from 'react';
import { Check } from 'lucide-react';
import type { ModelInfo } from '../types/bridge';
import { ModelIcon, providerOf } from './ModelIcon';

const ACCENT = 'var(--droid-accent)';

function ModelCatalogList({
  models,
  hasRealModels,
  selectedModelId,
  query,
  onSelectModel,
  disabled,
  showDefault = true,
}: {
  models: ModelInfo[];
  hasRealModels: boolean;
  selectedModelId: string | undefined;
  query: string;
  onSelectModel: (modelId?: string) => void;
  disabled: boolean;
  showDefault?: boolean;
}) {
  return (
    <div className="mt-2 max-h-[180px] overflow-y-auto -mx-1 px-1 space-y-0.5">
      {showDefault && (
        <ModelRow
          label="Default"
          sub="Use Factory CLI default"
          selected={!selectedModelId}
          onClick={() => {
            onSelectModel(undefined);
          }}
          disabled={disabled}
        />
      )}
      {hasRealModels ? (
        <>
          {models.map((model) => (
            <ModelRow
              key={model.id}
              label={model.displayName}
              sub={model.provider ?? (model.isCustom ? 'custom' : model.id)}
              model={model}
              selected={selectedModelId === model.id}
              onClick={() => {
                onSelectModel(model.id);
              }}
              disabled={disabled}
            />
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
  );
}

export default memo(ModelCatalogList);

function ModelRow({
  label,
  sub,
  selected,
  onClick,
  model,
  disabled = false,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  onClick: () => void;
  model?: ModelInfo;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left transition-colors ${
        disabled
          ? 'cursor-not-allowed opacity-50'
          : selected
            ? 'bg-droid-surface'
            : 'hover:bg-droid-surface/60'
      }`}
    >
      <span className="w-4 h-4 shrink-0 flex items-center justify-center">
        <ModelIcon provider={providerOf(model)} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-droid-text truncate">{label}</span>
        {sub && <span className="block text-[10px] text-droid-text-muted truncate">{sub}</span>}
      </span>
      {selected && <Check className="w-3 h-3 shrink-0" style={{ color: ACCENT }} strokeWidth={3} />}
    </button>
  );
}
