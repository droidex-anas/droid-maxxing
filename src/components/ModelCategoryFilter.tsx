import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, SlidersHorizontal } from 'lucide-react';
import type { ModelInfo } from '../types/bridge';

const ACCENT = 'var(--droid-accent)';
const accentMix = (pct: number) =>
  `color-mix(in srgb, var(--droid-accent) ${String(pct)}%, transparent)`;

export type ModelCategory = 'core' | 'factory' | 'custom';

export const CATEGORY_LABEL: Record<ModelCategory, string> = {
  core: 'Droid core',
  factory: 'Factory',
  custom: 'Custom',
};

export function categoryOf(model: ModelInfo): ModelCategory {
  if (model.isCustom || model.id.startsWith('custom:')) return 'custom';
  const provider = (model.provider ?? '').toLowerCase();
  if (provider === 'droid-core' || model.displayName.toLowerCase().startsWith('droid core'))
    return 'core';
  return 'factory';
}

export default function ModelCategoryFilter({
  source,
  cat,
  onSelect,
}: {
  source: readonly ModelInfo[];
  cat: ModelCategory | 'all';
  onSelect: (cat: ModelCategory | 'all') => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const catCounts = {
    core: 0,
    factory: 0,
    custom: 0,
  } satisfies Record<ModelCategory, number>;
  for (const model of source) catCounts[categoryOf(model)] += 1;

  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
    };
  }, [filterOpen]);

  return (
    <div className="relative shrink-0" ref={filterRef}>
      <button
        onClick={() => {
          setFilterOpen((v) => !v);
        }}
        title="Filter models by category"
        className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-colors ${
          filterOpen || cat !== 'all'
            ? 'text-droid-text border-transparent'
            : 'text-droid-text-muted border-droid-border hover:text-droid-text hover:border-droid-border-hover bg-droid-bg/60'
        }`}
        style={
          filterOpen || cat !== 'all'
            ? {
                backgroundColor: accentMix(13),
                boxShadow: `inset 0 0 0 1px ${accentMix(40)}`,
              }
            : undefined
        }
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
      </button>

      <AnimatePresence>
        {filterOpen && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 top-full mt-1.5 w-44 z-50 rounded-xl border border-droid-border bg-droid-elevated shadow-2xl shadow-black/50 overflow-hidden p-1"
          >
            {[
              { value: 'all' as const, label: 'All models', count: source.length },
              { value: 'core' as const, label: CATEGORY_LABEL.core, count: catCounts.core },
              {
                value: 'factory' as const,
                label: CATEGORY_LABEL.factory,
                count: catCounts.factory,
              },
              {
                value: 'custom' as const,
                label: CATEGORY_LABEL.custom,
                count: catCounts.custom,
              },
            ].map((opt) => {
              const on = cat === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => {
                    onSelect(opt.value);
                    setFilterOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[12px] transition-colors ${
                    on
                      ? 'bg-droid-surface text-droid-text'
                      : 'text-droid-text-secondary hover:bg-droid-surface/60'
                  }`}
                >
                  <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                    {on && (
                      <Check className="w-3 h-3" style={{ color: ACCENT }} strokeWidth={3.5} />
                    )}
                  </span>
                  <span className="flex-1">{opt.label}</span>
                  <span className="text-[10px] text-droid-text-muted">{opt.count}</span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
