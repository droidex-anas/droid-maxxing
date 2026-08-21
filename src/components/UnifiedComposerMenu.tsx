import { Check, Command, FileText, LoaderCircle, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import { PluginBrandIcon } from '../features/plugins/components/PluginBrandIcon';
import type { PluginDefinition } from '../features/plugins/pluginCatalog';
import { pluginReference } from '../lib/pluginReferences';
import type { SkillInfo } from '../types/bridge';

export interface SlashCommand {
  cmd: string;
  desc: string;
  replacement?: string;
  run: () => void;
}

export type MenuItem =
  | { type: 'command'; command: SlashCommand }
  | { type: 'skill'; skill: SkillInfo }
  | { type: 'plugin'; plugin: PluginDefinition }
  | { type: 'file'; path: string };

function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index >= 0 ? path.slice(index + 1) : path;
}

function relativeParent(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '';
}

function itemSection(item: MenuItem): 'Commands' | 'Plugins' | 'Skills' | 'Files' {
  if (item.type === 'command') return 'Commands';
  if (item.type === 'plugin') return 'Plugins';
  if (item.type === 'skill') return 'Skills';
  return 'Files';
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="px-3 pb-1.5 pt-2 text-[10px] font-medium text-droid-text-muted">
      {children}
    </div>
  );
}

export default function UnifiedComposerMenu({
  open,
  triggerKind,
  filesLoading,
  items,
  activeIndex,
  activeSkills,
  attachedFiles,
  activePluginReferences,
  onHoverItem,
  onRunItem,
}: {
  open: boolean;
  triggerKind: 'slash' | 'file' | null;
  filesLoading: boolean;
  items: MenuItem[];
  activeIndex: number;
  activeSkills: SkillInfo[];
  attachedFiles: string[];
  activePluginReferences: string[];
  onHoverItem: (index: number) => void;
  onRunItem: (item: MenuItem) => void;
}) {
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const activeSkillPaths = useMemo(
    () => new Set(activeSkills.map((skill) => skill.filePath)),
    [activeSkills],
  );
  const attached = useMemo(() => new Set(attachedFiles), [attachedFiles]);
  const activePlugins = useMemo(() => new Set(activePluginReferences), [activePluginReferences]);

  useEffect(() => {
    if (!open) return;
    rowRefs.current.get(activeIndex)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;

  let previousSection: string | null = null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-[18px] border border-droid-border bg-droid-surface shadow-[0_20px_65px_rgba(0,0,0,0.42)]">
      <div className="max-h-[360px] overflow-y-auto p-1.5">
        {items.map((item, index) => {
          const section = itemSection(item);
          const showSection = section !== previousSection;
          previousSection = section;

          const selected =
            item.type === 'skill'
              ? activeSkillPaths.has(item.skill.filePath)
              : item.type === 'plugin'
                ? activePlugins.has(pluginReference(item.plugin.slug))
                : item.type === 'file'
                  ? attached.has(item.path)
                  : false;

          return (
            <div key={item.type === 'command' ? item.command.cmd : item.type === 'skill' ? item.skill.filePath : item.type === 'plugin' ? item.plugin.id : item.path}>
              {showSection && <SectionLabel>{section}</SectionLabel>}
              <button
                ref={(node) => {
                  if (node) rowRefs.current.set(index, node);
                  else rowRefs.current.delete(index);
                }}
                type="button"
                onMouseEnter={() => onHoverItem(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onRunItem(item)}
                className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
                  index === activeIndex ? 'bg-droid-active' : 'hover:bg-droid-elevated/65'
                }`}
              >
                {item.type === 'plugin' ? (
                  <PluginBrandIcon plugin={item.plugin} size={28} />
                ) : item.type === 'skill' ? (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-droid-border bg-droid-elevated text-droid-accent">
                    <Sparkles className="h-3.5 w-3.5" />
                  </span>
                ) : item.type === 'command' ? (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-droid-border bg-droid-elevated text-droid-text-secondary">
                    <Command className="h-3.5 w-3.5" />
                  </span>
                ) : (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-droid-border bg-droid-elevated text-droid-text-secondary">
                    <FileText className="h-3.5 w-3.5" />
                  </span>
                )}

                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-[12.5px] font-medium text-droid-text">
                      {item.type === 'command'
                        ? item.command.cmd
                        : item.type === 'skill'
                          ? item.skill.name
                          : item.type === 'plugin'
                            ? item.plugin.name
                            : baseName(item.path)}
                    </span>
                    <span className="truncate text-[11.5px] text-droid-text-muted">
                      {item.type === 'command'
                        ? item.command.desc
                        : item.type === 'skill'
                          ? (item.skill.description ?? 'Agent skill')
                          : item.type === 'plugin'
                            ? item.plugin.description
                            : relativeParent(item.path)}
                    </span>
                  </span>
                </span>

                {selected && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-droid-text-muted">
                    <Check className="h-3 w-3" /> Added
                  </span>
                )}
              </button>
            </div>
          );
        })}

        {triggerKind === 'file' && filesLoading && (
          <div className="flex items-center gap-2 px-3 py-2.5 text-[11px] text-droid-text-muted">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Indexing files…
          </div>
        )}

        {items.length === 0 && !(triggerKind === 'file' && filesLoading) && (
          <div className="px-3 py-4 text-[11.5px] text-droid-text-muted">
            No matching plugins, skills, or files.
          </div>
        )}
      </div>
    </div>
  );
}
