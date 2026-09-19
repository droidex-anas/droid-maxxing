import { useState } from 'react';
import AutonomySelector from '../../components/AutonomySelector';
import ProviderPicker from '../providers/ProviderPicker';
import type { ThreadCatalog, ThreadSelection } from './useThreadSelection';

const selectClass =
  'min-w-0 max-w-[220px] rounded-lg bg-droid-elevated px-2 py-1.5 text-xs text-droid-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-droid-text-muted';

export function ThreadSettings({
  value,
  catalog,
  disabled,
  onChange,
}: {
  value: ThreadSelection;
  catalog: ThreadCatalog;
  disabled: boolean;
  onChange: (selection: ThreadSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const unknownModel = value.modelId && !catalog.models.some((item) => item.id === value.modelId);
  return (
    <div className="my-4 flex flex-wrap items-center gap-2">
      <ProviderPicker
        value={value.provider}
        locked={disabled}
        open={open}
        onOpenChange={setOpen}
        onSelect={(provider) => {
          onChange({ ...value, provider, modelId: '', reasoning: undefined });
        }}
      />
      <select
        aria-label="Thread model"
        value={value.modelId}
        disabled={disabled}
        onChange={(event) => {
          onChange({ ...value, modelId: event.target.value, reasoning: undefined });
        }}
        className={selectClass}
      >
        <option value="">{catalog.defaultModel?.displayName ?? 'Harness default'}</option>
        {unknownModel && <option value={value.modelId}>{value.modelId} (current)</option>}
        {catalog.models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName}
          </option>
        ))}
      </select>
      {catalog.efforts.length > 0 && (
        <select
          aria-label="Thread reasoning"
          value={value.reasoning ?? ''}
          disabled={disabled}
          onChange={(event) => {
            onChange({
              ...value,
              reasoning: catalog.efforts.find((effort) => effort === event.target.value),
            });
          }}
          className={selectClass}
        >
          <option value="">Default reasoning</option>
          {catalog.efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      )}
      <AutonomySelector
        scope="draft"
        value={value.autonomy}
        disabled={disabled}
        onSelect={(autonomy) => {
          onChange({ ...value, autonomy });
        }}
        placement="down"
      />
    </div>
  );
}
