import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { motion } from 'framer-motion';
import { FileText, List, Search } from 'lucide-react';
import { PanelRight } from '@droidex/icons';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { isSpecReaderFindTarget, isTranscriptFindShortcut } from '../lib/keyboardShortcuts';
import { extractOutline, type OutlineHeading } from '../lib/specOutline';
import { SpecDecisionForm } from './PlanApprovalInline';
import { SpecRenderer } from './SpecRenderer';

const EASE = [0.16, 1, 0.3, 1] as const;

// The reader docks beside the conversation: wide enough for comfortable
// reading, narrow enough that the chat column keeps its measure.
function readerWidth(): number {
  if (typeof window === 'undefined') return 520;
  return Math.round(Math.min(620, Math.max(420, window.innerWidth * 0.4)));
}

// Tracks the heading nearest the top of the reader's scroll container so the
// jump menu can mark the section being read.
function useActiveHeading(scrollRef: RefObject<HTMLDivElement | null>, headingIds: string[]) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || headingIds.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { root: container, rootMargin: '-64px 0px -70% 0px', threshold: 0 },
    );

    headingIds.forEach((id) => {
      const el = container.querySelector(`#${CSS.escape(id)}`);
      if (el) observer.observe(el);
    });

    return () => {
      observer.disconnect();
    };
  }, [scrollRef, headingIds]);

  return activeId;
}

// Section jump menu: a transient dropdown under the header rather than a
// permanent sidebar, so the narrow pane keeps its full width for the document.
// Carries data-spec-outline so transcript find yields Cmd/Ctrl+F to it.
function OutlineMenu({
  headings,
  activeId,
  onSelect,
  onClose,
}: {
  headings: OutlineHeading[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q ? headings.filter((h) => h.text.toLowerCase().includes(q)) : headings;

  return (
    <div
      data-spec-outline
      className="absolute top-11 right-3 z-20 flex max-h-[70%] w-64 flex-col overflow-hidden rounded-xl border border-droid-border bg-droid-surface shadow-droid"
    >
      <div className="shrink-0 border-b border-droid-border p-2">
        <div className="flex h-8 items-center gap-2 rounded-lg border border-droid-border bg-droid-bg/50 px-2.5 transition-colors focus-within:border-droid-border-hover">
          <Search className="h-3.5 w-3.5 shrink-0 text-droid-text-muted/60" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder="Find a section…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-droid-text outline-none placeholder:text-droid-text-muted"
          />
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-1.5 py-1.5">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-droid-text-muted/60">
            No matching sections
          </div>
        ) : (
          filtered.map((h) => {
            const isActive = activeId === h.id;
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => {
                  onSelect(h.id);
                  onClose();
                }}
                style={{ paddingLeft: (h.level - 1) * 12 + 10 }}
                className={`group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors ${
                  isActive ? 'bg-droid-elevated/60' : 'hover:bg-droid-elevated/30'
                }`}
              >
                <span
                  className="h-3.5 w-[3px] shrink-0 rounded-full transition-colors"
                  style={{ background: isActive ? 'var(--droid-accent)' : 'transparent' }}
                />
                <span
                  className={`truncate ${h.level === 1 ? 'text-[13px]' : 'text-[12px]'} ${
                    isActive
                      ? 'font-medium text-droid-text'
                      : 'text-droid-text-secondary group-hover:text-droid-text'
                  }`}
                >
                  {h.text}
                </span>
              </button>
            );
          })
        )}
      </nav>
    </div>
  );
}

// Docked spec/plan reader: the document rendered in full beside the chat, with
// the approval decision in the footer while one is pending. Opened from the
// inline preview card, the approval bar, or the Context panel.
export default function SpecReaderPanel({ appSessionId }: { appSessionId: string }) {
  const dispatch = useStoreDispatch();
  const { spec, approval } = useStoreSelector((current) => {
    const req = appSessionId ? current.pendingPermissions[appSessionId] : undefined;
    return {
      spec: appSessionId ? current.sessionSpecs[appSessionId] : undefined,
      approval: req && (req.kind === 'spec' || req.kind === 'mission_plan') ? req : undefined,
    };
  }, shallowEqual);

  const width = useMemo(readerWidth, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);

  const content = spec?.content ?? '';
  const outline = useMemo(() => extractOutline(content), [content]);
  const headingIds = useMemo(() => outline.map((h) => h.id), [outline]);
  const activeId = useActiveHeading(scrollRef, headingIds);

  const close = useCallback(() => {
    dispatch({ type: 'SPEC_CLOSE_READER' });
  }, [dispatch]);

  const scrollTo = useCallback((id: string) => {
    const container = scrollRef.current;
    if (!container) return;
    container.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, []);

  // Focus the document on open so arrows/space scroll and Esc closes.
  useEffect(() => {
    scrollRef.current?.focus();
  }, []);

  // Cmd/Ctrl+F originating inside the reader opens the section menu; elsewhere
  // it stays with transcript find (see shouldOpenTranscriptFind).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTranscriptFindShortcut(e) || !isSpecReaderFindTarget(e.target)) return;
      e.preventDefault();
      setOutlineOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className="h-full min-w-0 shrink-0 overflow-hidden"
    >
      <div
        data-spec-reader
        style={{ width }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          if (outlineOpen) setOutlineOpen(false);
          else close();
        }}
        className="relative flex h-full flex-col border-l border-droid-border bg-droid-surface"
      >
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-droid-border px-4">
          <FileText className="h-4 w-4 shrink-0 text-droid-text-muted" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-droid-text">
            {spec?.title ?? 'Specification'}
          </span>
          {approval && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: 'var(--droid-accent)' }}
              title="Awaiting your decision"
              aria-hidden
            />
          )}
          {outline.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setOutlineOpen((open) => !open);
              }}
              aria-expanded={outlineOpen}
              title="Jump to a section"
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] tabular-nums transition-colors ${
                outlineOpen
                  ? 'bg-droid-elevated text-droid-text'
                  : 'text-droid-text-muted hover:bg-droid-elevated/60 hover:text-droid-text'
              }`}
            >
              <List className="h-3.5 w-3.5" />
              {outline.length}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            title="Close reader (Esc)"
            aria-label="Close spec reader"
            className="shrink-0 rounded-md p-1.5 text-droid-text-muted/70 transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>

        {/* Document */}
        <div
          ref={scrollRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scroll-smooth outline-none"
        >
          {content ? (
            <div className="mx-auto max-w-2xl px-6 py-7">
              <SpecRenderer content={content} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-droid-text-muted">
              No spec content available.
            </div>
          )}
        </div>

        {/* Decision footer — only while a spec/plan approval is pending */}
        {approval && (
          <div className="shrink-0 border-t border-droid-border pt-3">
            <SpecDecisionForm req={approval} />
          </div>
        )}

        {outlineOpen && (
          <>
            {/* Click-away layer */}
            <div
              className="absolute inset-0 z-10"
              onClick={() => {
                setOutlineOpen(false);
              }}
            />
            <OutlineMenu
              headings={outline}
              activeId={activeId}
              onSelect={scrollTo}
              onClose={() => {
                setOutlineOpen(false);
              }}
            />
          </>
        )}
      </div>
    </motion.div>
  );
}
