import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DiffFileSection } from '../../../components/environment/DiffFileSection';
import { FileTypeIcon } from '../../../components/FileTypeIcon';
import { useStoreSelector } from '../../../hooks/useStore';
import type { DiffFile } from '../../../types/vcs';
import { splitPrPatch } from '../lib/prPatch';

const AUTO_EXPAND_MAX = 25;

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: DiffFile;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const slash = file.path.lastIndexOf('/');
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <button
      type="button"
      onClick={() => {
        onSelect(file.path);
      }}
      title={file.path}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
        selected ? 'bg-droid-active' : 'hover:bg-droid-elevated/50'
      }`}
    >
      <FileTypeIcon filename={file.path} className="h-3.5 w-3.5" />
      <span className="min-w-0 flex-1 truncate text-[12.5px]">
        {dir ? <span className="text-droid-text-muted/70">{dir}</span> : null}
        <span className="text-droid-text">{name}</span>
      </span>
      <span className="shrink-0 text-[11px] tabular-nums">
        {file.additions > 0 ? (
          <span style={{ color: 'var(--diff-add-fg)' }}>+{file.additions}</span>
        ) : null}{' '}
        {file.deletions > 0 ? (
          <span style={{ color: 'var(--diff-del-fg)' }}>-{file.deletions}</span>
        ) : null}
      </span>
    </button>
  );
}

export function PrDiff({ diff }: { diff: string }) {
  const diffView = useStoreSelector((state) => state.diffView);
  const files = useMemo(() => splitPrPatch(diff), [diff]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    setExpanded(
      files.length > 0 && files.length <= AUTO_EXPAND_MAX
        ? new Set(files.map((item) => item.file.path))
        : new Set(),
    );
    setActivePath(files[0]?.file.path ?? null);
  }, [files]);

  const registerSection = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(path, el);
    else sectionRefs.current.delete(path);
  }, []);

  const toggle = useCallback((path: string) => {
    setActivePath(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const jumpTo = useCallback((path: string) => {
    setActivePath(path);
    setExpanded((current) => (current.has(path) ? current : new Set(current).add(path)));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sectionRefs.current.get(path)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    });
  }, []);

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <p className="text-[13px] text-droid-text-muted">No file changes.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="Changed files"
        className="pr-workspace-scroll w-[220px] shrink-0 overflow-y-auto py-1"
      >
        {files.map((item) => (
          <FileRow
            key={item.file.path}
            file={item.file}
            selected={activePath === item.file.path}
            onSelect={jumpTo}
          />
        ))}
      </nav>
      <div className="pr-workspace-scroll min-h-0 min-w-0 flex-1 overflow-auto">
        {files.map((item) => (
          <DiffFileSection
            key={item.file.path}
            file={item.file}
            open={expanded.has(item.file.path)}
            active={activePath === item.file.path}
            entry={{
              diff: item.diff,
              loading: false,
              loaded: true,
              binary: item.file.binary,
            }}
            view={diffView}
            wrap={false}
            onToggle={toggle}
            onSectionRef={registerSection}
          />
        ))}
      </div>
    </div>
  );
}
