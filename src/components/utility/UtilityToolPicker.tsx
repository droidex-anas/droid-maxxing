import { motion, useReducedMotion } from 'framer-motion';
import type { UtilityTool } from '../../lib/utilityPanel';
import { preloadLazySurface } from '../../lib/chunkPreloader';
import type { LazySurface } from '../../lib/lazySurfaces';
import { utilityToolOption } from './utilityToolOptions';

const TOOL_SURFACES: Record<UtilityTool, LazySurface> = {
  review: 'review',
  browser: 'browser',
  terminal: 'terminal',
  files: 'files',
};

export function UtilityToolPicker({
  tools,
  onSelect,
  spacious = false,
}: {
  tools: UtilityTool[];
  onSelect: (tool: UtilityTool) => void;
  spacious?: boolean;
}) {
  const reduceMotion = useReducedMotion();

  // The empty pane shows the tools as a small tile grid; the header's add
  // menu shows them as a compact list with their shortcuts.
  if (spacious) {
    return (
      <div role="menu" aria-label="Utility tools" className="grid w-full grid-cols-2 gap-2.5">
        {tools.map((tool, index) => {
          const option = utilityToolOption(tool);
          const Icon = option.icon;
          return (
            <motion.button
              key={tool}
              type="button"
              role="menuitem"
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: index * 0.04, ease: [0.16, 1, 0.3, 1] }}
              onPointerEnter={() => {
                preloadLazySurface(TOOL_SURFACES[tool]);
              }}
              onFocus={() => {
                preloadLazySurface(TOOL_SURFACES[tool]);
              }}
              onClick={() => {
                onSelect(tool);
              }}
              className="group flex flex-col items-center justify-center gap-2.5 rounded-2xl border border-droid-border/60 bg-droid-elevated/25 px-3 py-6 text-[12px] font-medium text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:bg-droid-elevated/60 hover:text-droid-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent/60"
            >
              <Icon className="h-5 w-5 text-droid-text-muted transition-colors group-hover:text-droid-text" />
              <span>{option.label}</span>
            </motion.button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="menu" aria-label="Utility tools" className="p-1.5">
      {tools.map((tool) => {
        const option = utilityToolOption(tool);
        const Icon = option.icon;
        return (
          <button
            key={tool}
            type="button"
            role="menuitem"
            onPointerEnter={() => {
              preloadLazySurface(TOOL_SURFACES[tool]);
            }}
            onFocus={() => {
              preloadLazySurface(TOOL_SURFACES[tool]);
            }}
            onClick={() => {
              onSelect(tool);
            }}
            className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent/60"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-colors group-hover:text-droid-text" />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <span className="shrink-0 text-[11px] text-droid-text-muted">{option.shortcut}</span>
          </button>
        );
      })}
    </div>
  );
}
