import type { ProviderInstanceId, ProviderWireSnapshot } from '../../types/bridge';
import { HARNESS_DISPLAY_NAME, HARNESS_ORDER } from './harnessIdentity';
import { HarnessIcon } from './HarnessIcon';

export default function HarnessStrip({
  selected,
  locked,
  snapshots,
  onSelect,
}: {
  selected: ProviderInstanceId;
  locked: boolean;
  snapshots: readonly ProviderWireSnapshot[];
  onSelect: (providerInstanceId: ProviderInstanceId) => void;
}) {
  return (
    <div data-testid="harness-strip" className="px-3 pb-2" role="group" aria-label="Harness">
      <div className="grid grid-cols-5 gap-1 p-0.5 rounded-xl bg-droid-bg/60 border border-droid-border">
        {HARNESS_ORDER.map((id) => {
          const on = id === selected;
          const snapshot = snapshots.find((entry) => entry.definition.providerInstanceId === id);
          const lockedOut = locked && !on;
          const title = lockedOut
            ? 'Harness is locked after the first prompt'
            : (snapshot?.error?.message ?? HARNESS_DISPLAY_NAME[id]);
          return (
            <button
              key={id}
              type="button"
              data-testid="harness-option"
              data-harness={id}
              aria-pressed={on}
              disabled={lockedOut}
              title={title}
              onClick={() => {
                if (!lockedOut) onSelect(id);
              }}
              className={`flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[9px] font-medium transition-colors ${
                on
                  ? 'bg-droid-surface text-droid-text'
                  : lockedOut
                    ? 'text-droid-text-muted/40 cursor-not-allowed'
                    : 'text-droid-text-muted hover:text-droid-text-secondary'
              }`}
            >
              <HarnessIcon harness={id} size={14} />
              <span className="truncate w-full text-center">{HARNESS_DISPLAY_NAME[id]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
