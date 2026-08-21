import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AppWindow, FolderOpen, type LucideIcon } from 'lucide-react';

const ACCENT = 'var(--droid-accent)';

const WINDOW_MARGIN_PX = 12;
const PREFERRED_WIDTH_PX = 340;
const MIN_WIDTH_PX = 200;

// The menu opens from the plus button's left edge. On a cramped window that edge
// leaves too little room, so it narrows to what is left and then slides back from
// the window edge, rather than putting a row out of reach.
function fitToWindow(anchorLeft: number, windowWidth: number) {
  const room = windowWidth - anchorLeft - WINDOW_MARGIN_PX;
  const width = Math.min(PREFERRED_WIDTH_PX, Math.max(MIN_WIDTH_PX, room));
  return { width, left: Math.min(0, room - width) };
}

// One row of the menu. A row with `checked` toggles what it names, so it
// reports the state its Added marker shows; a row without it runs an action.
function MenuRow({
  icon: Icon,
  label,
  hint,
  checked,
  autoFocus = false,
  onRun,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  checked?: boolean;
  autoFocus?: boolean;
  onRun: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <button
      ref={ref}
      onClick={onRun}
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-droid-surface/55 focus:bg-droid-surface focus:outline-none"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
      <span className="shrink-0 text-[12.5px] font-medium text-droid-text">{label}</span>
      <span className="min-w-0 truncate text-[11.5px] text-droid-text-muted/75">{hint}</span>
      {checked && (
        <span className="ml-auto shrink-0 text-[10.5px] font-medium" style={{ color: ACCENT }}>
          Added
        </span>
      )}
    </button>
  );
}

function SectionTitle({ children, first = false }: { children: string; first?: boolean }) {
  return (
    <div
      className={`px-2.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-droid-text-muted/50 ${
        first ? 'pt-1' : 'pt-2.5'
      }`}
    >
      {children}
    </div>
  );
}

// The plus button's menu: what the next prompt can carry beyond words.
// Attachments and plugins live in one list so the button is a single entry
// point instead of a shortcut to the file picker.
export default function AddMenu({
  open,
  anchorRef,
  triggerRef,
  visualizeSelected,
  onAttachFiles,
  onToggleVisualize,
  onClose,
}: {
  open: boolean;
  /** Wraps the plus button and this menu, so pressing the button closes it
   *  through its own toggle instead of an outside-click that reopens it. */
  anchorRef: RefObject<HTMLElement | null>;
  /** The plus button itself, which takes focus back when Escape closes the menu
   *  the keyboard opened. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  visualizeSelected: boolean;
  onAttachFiles: () => void;
  onToggleVisualize: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ width: number; left: number }>();
  useLayoutEffect(() => {
    if (!open) return;
    // Measured from the trigger, not the menu, so a menu already slid left does
    // not feed its own offset back in.
    const refit = () => {
      const trigger = triggerRef.current;
      if (trigger) setFit(fitToWindow(trigger.getBoundingClientRect().left, window.innerWidth));
    };
    refit();
    window.addEventListener('resize', refit);
    return () => {
      window.removeEventListener('resize', refit);
    };
  }, [open, triggerRef]);

  // Arrow keys walk the rows, as they do in a menu; the rows themselves send
  // focus onward, into the file dialog or back to the draft.
  const moveFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [],
    );
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row === document.activeElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else if (e.key === 'ArrowDown') next = (current + 1) % rows.length;
    else if (e.key === 'ArrowUp') next = (current - 1 + rows.length) % rows.length;
    else return;
    e.preventDefault();
    rows.at(next)?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      triggerRef.current?.focus();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const anchor = anchorRef.current;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, anchorRef, triggerRef, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={menuRef}
          onKeyDown={moveFocus}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
          style={fit}
          className="absolute bottom-full left-0 z-50 mb-2 w-[340px] rounded-xl border border-droid-border bg-droid-elevated p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.16)]"
          role="menu"
          aria-label="Add to this prompt"
        >
          <SectionTitle first>Add</SectionTitle>
          <MenuRow
            icon={FolderOpen}
            label="Files"
            hint="Attach files to this prompt"
            autoFocus
            onRun={() => {
              onAttachFiles();
              onClose();
            }}
          />
          <SectionTitle>Plugins</SectionTitle>
          <MenuRow
            icon={AppWindow}
            label="Visualize"
            hint="Create an interactive in-chat App"
            checked={visualizeSelected}
            onRun={() => {
              onToggleVisualize();
              onClose();
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
