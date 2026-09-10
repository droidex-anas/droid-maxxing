import { useEffect, useRef, type ComponentType, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Bold,
  ClipboardCopy,
  ClipboardPaste,
  Code,
  Copy,
  ExternalLink,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Scissors,
  SquareCode,
  Table,
  TextSelect,
} from 'lucide-react';
import type { DraftFormatAction } from '../../lib/composerFormatting';

/* The composer's right-click menu. On a link it leads with opening or copying
   that link; then the editing actions every desktop app has — the draft cancels
   the platform menu to show this one, so it has to carry them itself; then
   formatting as compact icon rows, so the whole menu reads at a glance instead
   of scrolling through a column of labels. Selection-scoped actions (bold,
   link) hit what is selected; line-scoped ones (headings, lists, tables, code
   blocks) hit the line the caret is on. The menu only reports actions, so the
   draft stays owned by the composer. */

export type DraftEditAction = 'cut' | 'copy' | 'paste' | 'selectAll';

type MenuIcon = ComponentType<{ className?: string }>;

const MENU_WIDTH_PX = 200;

// [icon, label, action, shortcut, needsSelection]
const EDIT_ROWS: [MenuIcon, string, DraftEditAction, string, boolean][] = [
  [Scissors, 'Cut', 'cut', '⌘X', true],
  [Copy, 'Copy', 'copy', '⌘C', true],
  [ClipboardPaste, 'Paste', 'paste', '⌘V', false],
  [TextSelect, 'Select All', 'selectAll', '⌘A', false],
];

// [icon, name, action, shortcut] — inline marks, then line structure, then blocks.
type FormatButton = [MenuIcon, string, DraftFormatAction, string?];

const FORMAT_GROUPS: FormatButton[][] = [
  [
    [Bold, 'Bold', 'bold', '⌘B'],
    [Italic, 'Italic', 'italic', '⌘I'],
    [Code, 'Inline code', 'inlineCode', '⌘E'],
    [Link2, 'Link', 'link'],
  ],
  [
    [Heading1, 'Heading 1', 'heading1'],
    [Heading2, 'Heading 2', 'heading2'],
    [Heading3, 'Heading 3', 'heading3'],
    [Quote, 'Quote', 'quote'],
  ],
  [
    [List, 'Bulleted list', 'bulletList'],
    [ListOrdered, 'Numbered list', 'numberedList'],
    [ListTodo, 'Task list', 'taskList'],
    [Table, 'Table', 'table'],
    [SquareCode, 'Code block', 'codeBlock'],
  ],
];

function Separator() {
  return <div role="separator" className="mx-1.5 my-1 h-px bg-droid-active" />;
}

function TextRow({
  icon: Icon,
  label,
  hint,
  disabled = false,
  onSelect,
}: {
  icon: MenuIcon;
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-droid-surface/55 focus:bg-droid-surface focus:outline-none disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
      <span className="text-[12.5px] font-medium text-droid-text">{label}</span>
      {hint ? <span className="ml-auto text-[11px] text-droid-text-muted">{hint}</span> : null}
    </button>
  );
}

export default function SelectionMenu({
  position,
  hasSelection,
  link,
  onFormat,
  onEdit,
  onClose,
}: {
  position: { x: number; y: number } | null;
  hasSelection: boolean;
  // The address under the pointer when the draft was right-clicked on a link.
  link: string | null;
  onFormat: (action: DraftFormatAction) => void;
  onEdit: (action: DraftEditAction) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [position, onClose]);

  if (!position) return null;

  const choose = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Prompt actions"
      onContextMenu={(e: ReactMouseEvent) => {
        e.preventDefault();
      }}
      // The draft sits at the bottom of the window, so the menu grows upward
      // from the cursor and stops short of the right edge.
      style={{
        width: MENU_WIDTH_PX,
        left: Math.min(position.x, window.innerWidth - MENU_WIDTH_PX - 10),
        top: position.y - 4,
        transform: 'translateY(-100%)',
      }}
      className="fixed z-50 max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-droid-border-hover bg-droid-elevated p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
    >
      {link ? (
        <>
          <TextRow
            icon={ExternalLink}
            label="Open Link"
            onSelect={choose(() => window.open(link, '_blank', 'noopener,noreferrer'))}
          />
          <TextRow
            icon={ClipboardCopy}
            label="Copy Link Address"
            onSelect={choose(() => void navigator.clipboard.writeText(link))}
          />
          <Separator />
        </>
      ) : null}
      {EDIT_ROWS.map(([icon, label, action, hint, needsSelection]) => (
        <TextRow
          key={action}
          icon={icon}
          label={label}
          hint={hint}
          disabled={needsSelection && !hasSelection}
          onSelect={choose(() => {
            onEdit(action);
          })}
        />
      ))}
      <Separator />
      {FORMAT_GROUPS.map((group, index) => (
        <div key={index} className="flex items-center gap-0.5 px-1 py-0.5">
          {group.map(([Icon, name, action, shortcut]) => (
            <button
              key={action}
              role="menuitem"
              aria-label={name}
              title={shortcut ? `${name}  ${shortcut}` : name}
              onClick={choose(() => {
                onFormat(action);
              })}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-droid-text-secondary transition-colors hover:bg-droid-surface/55 hover:text-droid-text focus:bg-droid-surface focus:outline-none"
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
