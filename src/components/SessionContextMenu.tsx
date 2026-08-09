import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Archive, Copy, FileText, Folder, Link2, Pencil, Pin, PinOff } from 'lucide-react';
import { pushEscapeLayer } from './environment/usePopover';
import { toast } from '../lib/toast';

const EASE = [0.16, 1, 0.3, 1] as const;
export const SESSION_MENU_WIDTH = 220;
const MENU_MARGIN = 8;
// Fixed chrome of the panel (padding + divider) plus one row's height. The
// row count varies with which copy actions are available, so the clamp
// estimate is computed per-open instead of using a worst-case constant.
const MENU_CHROME_PX = 18;
const MENU_ROW_PX = 30;

// POSIX single-quote: wrap in '...', escaping embedded quotes as '\''. The
// resume recipe is pasted into a shell, so an unquoted path with spaces (or
// shell metacharacters) would break or execute unintended text.
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const itemClass =
  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text focus-visible:bg-droid-elevated/60 focus-visible:text-droid-text focus-visible:outline-none';

// Where the Factory web app renders a synced session. Deep links only resolve
// for sessions that cloud sync has uploaded (signed-in, non-airgap).
const sessionWebLink = (providerSessionId: string) =>
  `https://app.factory.ai/sessions/${providerSessionId}`;

function copyText(text: string, message: string): void {
  // The Electron renderer always exposes the clipboard API; a rejected write
  // (e.g. window unfocused) surfaces as an error toast.
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(message))
    .catch(() => toast.error('Could not copy to the clipboard.'));
}

export interface SessionContextMenuProps {
  x: number;
  y: number;
  pinned: boolean;
  // Absent for workspace-less sessions; the Copy Working Directory row hides.
  cwd?: string;
  // The real Droid session id (vs our appSessionId). Absent until the harness
  // assigns one; the session-id/link rows hide in that case.
  providerSessionId?: string;
  onRename: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onCopyMarkdown: () => void;
  onClose: () => void;
}

// Action menu for a sidebar chat row (right-click or the hover "..." button).
// Organization actions (pin/rename/archive) are app-level; the copy actions
// expose the real Droid session so the user can continue it in the official
// CLI (`droid -r <id>`) or the Factory web app. The portal + click-away
// backdrop live here; the panel is separate so tests can render it without a
// DOM (portals reject fake containers even in SSR).
export function SessionContextMenu(props: SessionContextMenuProps) {
  return createPortal(
    <>
      {/* Click-away layer; a right-click outside dismisses instead of stacking menus. */}
      <div
        className="fixed inset-0 z-[990]"
        data-testid="session-context-menu-backdrop"
        onMouseDown={props.onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onClose();
        }}
      />
      {/* The panel suppresses the native context menu so right-clicking an item doesn't stack a browser menu over ours. */}
      <SessionContextMenuPanel {...props} />
    </>,
    document.body,
  );
}

export function SessionContextMenuPanel({
  x,
  y,
  pinned,
  cwd,
  providerSessionId,
  onRename,
  onTogglePin,
  onArchive,
  onCopyMarkdown,
  onClose,
}: SessionContextMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape uses the shared layer stack so a menu opened over another overlay
  // closes first; blur and scroll dismiss like a native context menu.
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

  // Keyboard access: focus the first item on open, arrows walk the items, and
  // Enter/Space activate the focused button natively. On close, focus returns
  // to the element that opened the menu (WAI-ARIA menu pattern) unless the
  // user already moved it — e.g. the rename flow's autofocused input, or a
  // click that focused another control.
  useEffect(() => {
    const opener = document.activeElement;
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      const focusDiedWithMenu =
        document.activeElement === null || document.activeElement === document.body;
      if (
        opener instanceof HTMLElement &&
        opener !== document.body &&
        opener.isConnected &&
        focusDiedWithMenu
      ) {
        opener.focus();
      }
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = panelRef.current?.querySelectorAll<HTMLButtonElement>('button');
    if (!items || items.length === 0) return;
    // activeElement is a DOM `Element | null`; narrowed only for the indexOf
    // walk (a non-button simply yields -1 and navigation starts from item 0).
    const index = [...items].indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
    items[next].focus();
  };

  // Clamp to the viewport so the menu never opens partly off-screen. The
  // height estimate counts the rows actually rendered so a short menu doesn't
  // jump away from the pointer near the bottom edge. SSR (the panel's tests
  // render with renderToStaticMarkup) has no viewport, so it renders
  // unclamped; the clamp applies on the client where a window exists.
  const viewportWidth = typeof window === 'undefined' ? undefined : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? undefined : window.innerHeight;
  const rowCount = 4 + (cwd ? 1 : 0) + (providerSessionId ? 2 : 0);
  const estimatedMenuHeight = MENU_CHROME_PX + rowCount * MENU_ROW_PX;
  const left =
    viewportWidth === undefined
      ? Math.max(MENU_MARGIN, x)
      : Math.min(
          Math.max(MENU_MARGIN, x),
          Math.max(MENU_MARGIN, viewportWidth - SESSION_MENU_WIDTH - MENU_MARGIN),
        );
  const top =
    viewportHeight === undefined
      ? Math.max(MENU_MARGIN, y)
      : Math.min(
          Math.max(MENU_MARGIN, y),
          Math.max(MENU_MARGIN, viewportHeight - estimatedMenuHeight - MENU_MARGIN),
        );

  const copyAndClose = (text: string, message: string) => {
    copyText(text, message);
    onClose();
  };

  return (
    <motion.div
      ref={panelRef}
      role="menu"
      aria-label="Chat actions"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12, ease: EASE }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
      style={{ position: 'fixed', left, top, width: SESSION_MENU_WIDTH }}
      className="z-[991] rounded-xl border border-droid-border bg-droid-surface p-1 shadow-2xl shadow-black/50"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onTogglePin();
          onClose();
        }}
        className={itemClass}
      >
        {pinned ? (
          <PinOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Pin className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        )}
        {pinned ? 'Unpin chat' : 'Pin chat'}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onRename();
          onClose();
        }}
        className={itemClass}
      >
        <Pencil className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Rename chat
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onArchive();
          onClose();
        }}
        className={itemClass}
      >
        <Archive className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Archive chat
      </button>
      <div role="separator" className="mx-1 my-1 h-px bg-droid-border" />
      {cwd && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            copyAndClose(cwd, 'Working directory copied.');
          }}
          className={itemClass}
        >
          <Folder className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          Copy Working Directory
        </button>
      )}
      {providerSessionId && (
        <button
          type="button"
          role="menuitem"
          // Sessions are filed per working directory, so the reliable resume
          // recipe is cd + resume; the toast spells out both, shell-quoted so
          // a path with spaces pastes back intact.
          onClick={() => {
            const resume = cwd
              ? `cd ${shellQuote(cwd)} && droid -r ${shellQuote(providerSessionId)}`
              : `droid -r ${shellQuote(providerSessionId)}`;
            copyAndClose(
              providerSessionId,
              `Droid session ID copied. Continue in the official CLI: ${resume}`,
            );
          }}
          className={itemClass}
        >
          <Copy className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          Copy Session ID
        </button>
      )}
      {providerSessionId && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            copyAndClose(sessionWebLink(providerSessionId), 'Session link copied.');
          }}
          className={itemClass}
        >
          <Link2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          Copy Session Link
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCopyMarkdown();
          onClose();
        }}
        className={itemClass}
      >
        <FileText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Copy as Markdown
      </button>
    </motion.div>
  );
}
