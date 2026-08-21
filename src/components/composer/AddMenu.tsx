import { useEffect, useRef, type RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AppWindow, FolderOpen, type LucideIcon } from 'lucide-react';

const ACCENT = 'var(--droid-accent)';

function MenuRow({
  icon: Icon,
  label,
  hint,
  added = false,
  autoFocus = false,
  onRun,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  added?: boolean;
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
      className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-droid-surface/55 focus:bg-droid-surface focus:outline-none"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
      <span className="shrink-0 text-[12.5px] font-medium text-droid-text">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right text-[11.5px] text-droid-text-muted/75">
        {hint}
      </span>
      {added && (
        <span className="shrink-0 text-[10.5px] font-medium" style={{ color: ACCENT }}>
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
  anchorRef,
  visualizeSelected,
  onAttachFiles,
  onSelectVisualize,
  onClose,
}: {
  /** Wraps the plus button and this menu, so pressing the button closes it
   *  through its own toggle instead of an outside-click that reopens it. */
  anchorRef: RefObject<HTMLElement | null>;
  visualizeSelected: boolean;
  onAttachFiles: () => void;
  onSelectVisualize: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
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
  }, [anchorRef, onClose]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 6 }}
        transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
        className="absolute bottom-full left-0 z-50 mb-2 w-[340px] rounded-xl border border-droid-border bg-droid-elevated p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.16)]"
        role="menu"
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
          added={visualizeSelected}
          onRun={() => {
            onSelectVisualize();
            onClose();
          }}
        />
      </motion.div>
    </AnimatePresence>
  );
}
