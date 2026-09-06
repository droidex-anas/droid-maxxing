import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Folder, FolderMinus, FolderOpen, Plus } from 'lucide-react';
import { pushEscapeLayer } from './environment/usePopover';

const EASE = [0.16, 1, 0.3, 1] as const;
const MENU_WIDTH = 200;
const MENU_MARGIN = 8;
const MENU_CHROME_PX = 18;
const MENU_ROW_PX = 30;

const itemClass =
  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text focus-visible:bg-droid-elevated/60 focus-visible:text-droid-text focus-visible:outline-none';

function WorkspaceFolderIcon({ open }: { open: boolean }) {
  const reduceMotion = useReducedMotion();
  const duration = reduceMotion ? 0 : 0.15;
  return (
    <span className="relative block h-4 w-4 shrink-0 text-droid-text-muted">
      <motion.span
        className="absolute inset-0 flex items-center justify-center"
        initial={false}
        animate={{ opacity: open ? 0 : 1 }}
        transition={{ duration, ease: EASE }}
      >
        <Folder className="h-4 w-4" />
      </motion.span>
      <motion.span
        className="absolute inset-0 flex items-center justify-center"
        initial={false}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration, ease: EASE }}
      >
        <FolderOpen className="h-4 w-4" />
      </motion.span>
    </span>
  );
}

export function WorkspaceContextMenuPanel({
  x,
  y,
  name,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  name: string;
  onRemove: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pop = pushEscapeLayer(onClose);
    window.addEventListener('blur', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      pop();
      window.removeEventListener('blur', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  const viewportWidth = typeof window === 'undefined' ? undefined : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? undefined : window.innerHeight;
  const estimatedMenuHeight = MENU_CHROME_PX + MENU_ROW_PX;
  const left =
    viewportWidth === undefined
      ? Math.max(MENU_MARGIN, x)
      : Math.min(Math.max(MENU_MARGIN, x), viewportWidth - MENU_WIDTH - MENU_MARGIN);
  const top =
    viewportHeight === undefined
      ? Math.max(MENU_MARGIN, y)
      : Math.min(Math.max(MENU_MARGIN, y), viewportHeight - estimatedMenuHeight - MENU_MARGIN);

  return (
    <motion.div
      ref={panelRef}
      role="menu"
      aria-label={`${name} workspace`}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12, ease: EASE }}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      style={{ position: 'fixed', left, top, width: MENU_WIDTH }}
      className="z-[991] rounded-xl border border-droid-border bg-droid-surface p-1 shadow-2xl shadow-black/50"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onRemove();
          onClose();
        }}
        className={itemClass}
      >
        <FolderMinus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Remove workspace
      </button>
    </motion.div>
  );
}

function WorkspaceContextMenu({
  x,
  y,
  name,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  name: string;
  onRemove: () => void;
  onClose: () => void;
}) {
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[990]"
        onMouseDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <WorkspaceContextMenuPanel x={x} y={y} name={name} onRemove={onRemove} onClose={onClose} />
    </>,
    document.body,
  );
}

export function SidebarWorkspaceRow({
  name,
  open,
  onToggle,
  onNewChat,
  onRemove,
  children,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  return (
    <div>
      <div className="group flex items-center gap-1 px-1 py-1">
        <button
          type="button"
          onClick={onToggle}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-droid-elevated/40"
        >
          <WorkspaceFolderIcon open={open} />
          <span className="min-w-0 flex-1 truncate text-[13.5px] text-droid-text">{name}</span>
        </button>
        <button
          type="button"
          onClick={onNewChat}
          title="New chat here"
          className="shrink-0 rounded-md p-0.5 text-droid-text-muted/0 transition-colors group-hover:text-droid-text-muted hover:bg-droid-elevated/60 hover:text-droid-text"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
      {menu ? (
        <WorkspaceContextMenu
          x={menu.x}
          y={menu.y}
          name={name}
          onRemove={onRemove}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}
