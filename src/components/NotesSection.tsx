import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { NotesIntroCard } from './NotesIntroCard';
import { INTRO_WIDTH, notesIntroPosition } from '../lib/notesIntro';
import { RowCaret } from './environment/primitives';
import {
  NOTE_TAG_CHIP,
  NOTE_TAG_HINT,
  composeNoteText,
  exactNoteTag,
  noteTagMenu,
  noteTextWithoutTag,
  parseNoteTag,
  type NoteTag,
} from '../lib/notesTags';
import { dismissNotesIntro, loadNotesIntroSeen, type SessionNote } from '../lib/sessionNotes';

const EASE = [0.16, 1, 0.3, 1] as const;
const EMPTY_NOTES: SessionNote[] = [];

// Scratch notes for the active session: write a thought down in the pad, it
// stacks as a checklist line, and clicking a line hands the text to the
// composer so it can be sent as a prompt. The bullet fills once a note has
// been sent. Notes persist per session across restarts.
export default function NotesSection({ appSessionId }: { appSessionId: string }) {
  const dispatch = useStoreDispatch();
  const notes = useStoreSelector((state) => state.sessionNotes[appSessionId] ?? EMPTY_NOTES);
  const [draft, setDraft] = useState('');
  // Tag chipped in the pad via the @ menu; save folds it into the note text.
  const [tag, setTag] = useState<NoteTag | null>(null);
  // One-time "what's new" spotlight for the feature, per profile.
  const [introVisible, setIntroVisible] = useState(() => !loadNotesIntroSeen());

  const save = () => {
    if (!draft.trim()) return;
    dispatch({ type: 'SESSION_NOTE_ADD', appSessionId, text: composeNoteText(tag, draft) });
    setDraft('');
    setTag(null);
  };

  const dismissIntro = () => {
    setIntroVisible(false);
    dismissNotesIntro();
  };

  return (
    <NotesPanel
      notes={notes}
      draft={draft}
      onDraftChange={setDraft}
      onSave={save}
      onUse={(note) => {
        dispatch({ type: 'SEED_COMPOSER', text: note.text });
        dispatch({ type: 'SESSION_NOTE_MARK_USED', appSessionId, noteId: note.id });
      }}
      onRemove={(noteId) => {
        dispatch({ type: 'SESSION_NOTE_REMOVE', appSessionId, noteId });
      }}
      introVisible={introVisible}
      onDismissIntro={dismissIntro}
      tag={tag}
      onTagSelect={(next) => {
        setTag(next);
        setDraft('');
      }}
      onTagClear={() => {
        setTag(null);
      }}
    />
  );
}

// Presentational half, kept pure so the layout can be tested without a store.
// Speaks the same section language as the rest of the Context panel: a muted
// header row with a disclosure caret, content on the shared px-3 gutter — no
// nested card chrome of its own.
export function NotesPanel({
  notes,
  draft,
  onDraftChange,
  onSave,
  onUse,
  onRemove,
  introVisible,
  onDismissIntro,
  tag,
  onTagSelect,
  onTagClear,
  defaultOpen = false,
}: {
  notes: SessionNote[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onUse: (note: SessionNote) => void;
  onRemove: (noteId: string) => void;
  introVisible: boolean;
  onDismissIntro: () => void;
  tag: NoteTag | null;
  onTagSelect: (tag: NoteTag) => void;
  onTagClear: () => void;
  defaultOpen?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  // Collapsed by default: notes are a supporting tool, and opening the panel
  // should never reshuffle the layout because a textarea mounted.
  const [open, setOpen] = useState(defaultOpen);
  const [anchorRect, setAnchorRect] = useState<{
    top: number;
    left: number;
    height: number;
  } | null>(null);
  const used = notes.filter((note) => note.usedAt !== null).length;

  // Pad @ autocomplete: while the whole draft is just a @token, the menu lists
  // matching tags; picking one chips it in the pad. Index and suppression are
  // pure UI state; the chip itself is controlled by the wrapper above.
  const [tagMenuIndex, setTagMenuIndex] = useState(0);
  const [tagMenuSuppressed, setTagMenuSuppressed] = useState(false);
  const { query: tagQuery, matching: matchingTags } = noteTagMenu(draft, tag);
  const tagMenuOpen = !tagMenuSuppressed && matchingTags.length > 0;
  const activeTagIndex = Math.max(0, Math.min(tagMenuIndex, matchingTags.length - 1));

  const selectTag = (next: NoteTag) => {
    onTagSelect(next);
    setTagMenuIndex(0);
    setTagMenuSuppressed(false);
  };

  // After a tag chips in, land the caret in the pad for the body.
  const hadTag = useRef(tag !== null);
  useEffect(() => {
    const hasTag = tag !== null;
    if (hasTag && !hadTag.current) textareaRef.current?.focus();
    hadTag.current = hasTag;
  }, [tag]);

  // Track the section's viewport position while the intro is up so the
  // floating card stays glued to it. The capture-phase scroll listener also
  // catches the panel's own scroll container, which does not bubble.
  useEffect(() => {
    if (!introVisible) return;
    const measure = () => {
      const el = sectionRef.current;
      if (!el) {
        setAnchorRect(null);
        return;
      }
      // The section spans the panel edge to edge while its rows sit on the
      // px-3 gutter; anchoring to the raw rect would push the floating intro
      // 12px too far left and detach its caret from the Notes row.
      const rect = el.getBoundingClientRect();
      setAnchorRect({ top: rect.top, left: rect.left + 12, height: rect.height });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    // Sections above Notes can expand inline (commit/PR sheets) and the pad
    // grows with the draft, neither of which fires resize or scroll. The
    // section sits inside single-purpose wrappers (this component's root and
    // the panel's per-section slot), so watch every sibling group on the way
    // up to the scroll container to catch the layout shifts that move Notes
    // without resizing it.
    let observer: ResizeObserver | null = null;
    const section = sectionRef.current;
    if (section && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure);
      for (let el: HTMLElement | null = section; el; el = el.parentElement) {
        observer.observe(el);
        const parent: HTMLElement | null = el.parentElement;
        if (!parent) break;
        for (const sibling of parent.children) {
          if (sibling !== el) observer.observe(sibling);
        }
        const overflowY = getComputedStyle(parent).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') break;
      }
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [introVisible, open, notes.length]);

  // "Try it now" lands the caret in the pad; if the section is collapsed the
  // pad only mounts after it opens, so the focus waits for that render.
  const focusAfterOpen = useRef(false);
  const tryNotes = () => {
    onDismissIntro();
    if (open) {
      textareaRef.current?.focus();
      return;
    }
    focusAfterOpen.current = true;
    setOpen(true);
  };
  useEffect(() => {
    if (open && focusAfterOpen.current) {
      focusAfterOpen.current = false;
      textareaRef.current?.focus();
    }
  }, [open]);

  // The pad starts three lines tall so it reads as a place to write, then
  // grows with the text like the main composer, capped so a long note scrolls
  // instead of swallowing the panel. Reopen is a dep too: collapsing unmounts
  // the pad and drops its fitted height, so it must refit on the fresh mount.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, 168))}px`;
  }, [draft, open]);

  // anchorRect only exists client-side after measurement, so window is safe.
  const introPos = anchorRect ? notesIntroPosition(anchorRect, window.innerHeight) : null;

  return (
    <div>
      <div ref={sectionRef}>
        <button
          type="button"
          onClick={() => {
            setOpen(!open);
          }}
          aria-expanded={open}
          className="group flex w-full items-center gap-2 px-3 pb-1 pt-4 text-left"
        >
          <span className="min-w-0 flex-1 text-[12px] font-medium text-droid-text-muted">
            Notes
          </span>
          {notes.length > 0 && (
            <span className="shrink-0 text-[11px] leading-none tabular-nums text-droid-text-muted">
              {used}/{notes.length} sent
            </span>
          )}
          <RowCaret open={open} />
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="pb-2 pt-1">
                {/* Notepad field: intentionally plain — Enter saves, no send
                    chrome. Uses the field token: raised like the composer on
                    dark, crisp card-surface on light. */}
                <div className="mx-3">
                  <div className="rounded-lg border border-droid-border/60 bg-droid-field px-2.5 py-2 transition-colors focus-within:border-droid-accent/40">
                    {tag && (
                      <div className="mb-1 flex">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${NOTE_TAG_CHIP[tag]}`}
                        >
                          {tag}
                          <button
                            type="button"
                            aria-label="Remove tag"
                            onClick={onTagClear}
                            className="rounded-sm opacity-70 transition-opacity hover:opacity-100"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      </div>
                    )}
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={(event) => {
                        onDraftChange(event.target.value);
                        setTagMenuIndex(0);
                        setTagMenuSuppressed(false);
                      }}
                      onKeyDown={(event) => {
                        if (tagMenuOpen) {
                          if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setTagMenuIndex((activeTagIndex + 1) % matchingTags.length);
                            return;
                          }
                          if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setTagMenuIndex(
                              (activeTagIndex + matchingTags.length - 1) % matchingTags.length,
                            );
                            return;
                          }
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            // The menu is only open with matches, and the index
                            // is clamped into range, so this always exists.
                            selectTag(matchingTags[activeTagIndex]);
                            return;
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setTagMenuSuppressed(true);
                            return;
                          }
                          // Typing the tag out and hitting Space chips it too,
                          // so the menu is a shortcut, not a requirement.
                          if (event.key === ' ') {
                            const exact = exactNoteTag(tagQuery, matchingTags);
                            if (exact) {
                              event.preventDefault();
                              selectTag(exact);
                              return;
                            }
                          }
                        }
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          onSave();
                          return;
                        }
                        if (event.key === 'Backspace' && draft === '' && tag !== null) {
                          onTagClear();
                        }
                      }}
                      placeholder={
                        tag
                          ? 'Add the detail — Enter to save'
                          : 'Write a note to use later — Enter to save'
                      }
                      rows={3}
                      className="w-full resize-none bg-transparent text-[13px] leading-snug text-droid-text placeholder:text-droid-text-muted focus:outline-none"
                    />
                    {/* The pad saves on Enter with no other chrome, so the moment
                        text exists a plain save affordance and the key hints appear. */}
                    {draft.trim() !== '' && (
                      <div className="mt-1 flex items-center justify-end gap-2.5">
                        <span className="text-[11px] text-droid-text-muted/60">
                          Enter to save · Shift+Enter for a new line
                        </span>
                        <button
                          type="button"
                          onClick={onSave}
                          className="text-[11px] font-medium text-droid-text-secondary transition-colors hover:text-droid-text"
                        >
                          Save
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Tag menu in flow directly below the pad: as an absolute
                      overlay it was clipped by the collapse container's
                      overflow-hidden whenever the note list was shorter than
                      the menu (the empty first-run state). */}
                  <AnimatePresence>
                    {tagMenuOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15, ease: EASE }}
                        className="mt-1.5 overflow-hidden rounded-xl border border-droid-border bg-droid-elevated py-1 shadow-droid"
                      >
                        {matchingTags.map((option, index) => (
                          <button
                            key={option}
                            type="button"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              selectTag(option);
                            }}
                            onMouseEnter={() => {
                              setTagMenuIndex(index);
                            }}
                            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                              index === activeTagIndex ? 'bg-droid-hover/60' : ''
                            }`}
                          >
                            <span
                              className={`px-1.5 py-px text-[11px] font-medium uppercase tracking-wide ${NOTE_TAG_CHIP[option]}`}
                            >
                              {option}
                            </span>
                            <span className="text-[12px] text-droid-text-muted">
                              {NOTE_TAG_HINT[option]}
                            </span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="mt-0.5">
                  <AnimatePresence initial={false}>
                    {notes.map((note) => {
                      const tag = parseNoteTag(note.text);
                      return (
                        <motion.div
                          key={note.id}
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.22, ease: EASE }}
                          className="group relative overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              onUse(note);
                            }}
                            title="Send to composer"
                            className="flex w-full items-start gap-2.5 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-droid-hover/60 focus-visible:bg-droid-hover/60 focus-visible:outline-none"
                          >
                            <span
                              aria-hidden
                              className={`mt-[3px] h-[13px] w-[13px] shrink-0 rounded-full border-[1.5px] transition-colors duration-300 ${
                                note.usedAt !== null
                                  ? 'border-droid-accent bg-droid-accent'
                                  : 'border-droid-text-muted/40 group-hover:border-droid-text-muted/70'
                              }`}
                            />
                            <span
                              className={`line-clamp-2 min-w-0 flex-1 break-words pr-4 text-[13px] leading-snug transition-colors ${
                                note.usedAt !== null
                                  ? 'text-droid-text-muted'
                                  : 'text-droid-text-secondary group-hover:text-droid-text'
                              }`}
                            >
                              {tag && (
                                <span
                                  className={`mr-1.5 px-1.5 py-px text-[11px] font-medium uppercase tracking-wide ${NOTE_TAG_CHIP[tag]}`}
                                >
                                  {tag}
                                </span>
                              )}
                              {tag ? noteTextWithoutTag(note.text) : note.text}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onRemove(note.id);
                            }}
                            title="Delete note"
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-droid-text-muted opacity-0 transition-opacity hover:bg-droid-active hover:text-droid-text focus-visible:opacity-100 group-hover:opacity-100"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>

                  {notes.length === 0 && (
                    <div className="px-3 py-1.5 text-[12px] leading-snug text-droid-text-muted">
                      No notes yet — write one above, Enter to save. Start it with @bug, @next,
                      @idea or @constraint to tag it.
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Floating intro, portaled out so the panel's scroll box can't clip it.
          Server renders have no document, so static markup stays anchor-only. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {introVisible && introPos && (
              <NotesIntroCard
                style={{
                  position: 'fixed',
                  top: introPos.top,
                  left: introPos.left,
                  width: INTRO_WIDTH,
                }}
                caretTop={introPos.caretTop}
                onTry={tryNotes}
                onClose={onDismissIntro}
              />
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}
