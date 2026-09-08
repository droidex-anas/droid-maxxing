import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AriaRole,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { calculatePopoverPosition, type PopoverPosition } from './popoverPosition';
import { pushEscapeLayer } from './usePopover';

// The app scales its UI with a CSS zoom on #root (the UI font size setting),
// but this panel portals to <body>, outside that zoom. Anchor rects are
// measured in scaled pixels, so the positioning math converts the panel's
// footprint and available space by the same factor, and the content box
// applies the zoom itself to render at the app's scale. applyTheme sets the
// variable inline on #root, so read it there — the portal inherits only the
// :root default from <body>.
function uiZoomFactor(): number {
  const owner = document.getElementById('root') ?? document.documentElement;
  const raw = getComputedStyle(owner).getPropertyValue('--ui-zoom');
  const factor = Number.parseFloat(raw);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

// A dropdown panel rendered into <body> via a portal so it escapes the Context
// panel's `overflow` clipping. It stays anchored to its trigger and reflows on
// scroll/resize, and clamps to the viewport so it is never cropped.
export function Popover({
  open,
  onClose,
  anchorRef,
  label,
  id,
  align = 'right',
  width = 288,
  role = 'dialog',
  initialFocusSelector,
  trapFocus = true,
  onKeyDown,
  className = '',
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label?: string;
  id?: string;
  align?: 'left' | 'right';
  width?: number | 'anchor';
  role?: AriaRole;
  initialFocusSelector?: string;
  trapFocus?: boolean;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  // Drives the enter transition: mount at opacity-0/scale-95, then flip on the
  // next frame so the CSS transition has a starting state to animate from.
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => {
      setEntered(true);
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [open]);

  // If focus is inside the panel when it closes (Escape from the search input,
  // an activated row unmounting), it would fall to <body>; hand it back to the
  // trigger instead. React clears panelRef and unmounts the portal before this
  // cleanup runs, so containment can't be checked at teardown: track it live
  // via focusin while the panel is open. A close by outside-click moves focus
  // to the clicked target (or <body>) before cleanup, so it clears the flag and
  // does not steal focus back.
  const focusInsideRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    const track = () => {
      focusInsideRef.current = !!panelRef.current?.contains(document.activeElement);
    };
    track();
    // If nothing inside the panel grabbed focus on open (e.g. an input with
    // autoFocus), move focus to the first focusable element so the first Tab
    // is trapped. Otherwise focus stays on the trigger and Tab escapes the
    // portal, bypassing the onKeyDown trap which only fires inside the panel.
    if (!focusInsideRef.current && panelRef.current) {
      const initial = initialFocusSelector
        ? panelRef.current.querySelector<HTMLElement>(initialFocusSelector)
        : null;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      let focusTarget = initial;
      focusTarget ??= focusables.length > 0 ? focusables[0] : panelRef.current;
      focusTarget.focus({ preventScroll: true });
      track();
    }
    document.addEventListener('focusin', track);
    const anchor = anchorRef.current;
    return () => {
      document.removeEventListener('focusin', track);
      if (focusInsideRef.current) anchor?.focus({ preventScroll: true });
      focusInsideRef.current = false;
    };
  }, [open, anchorRef, initialFocusSelector]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const zoom = uiZoomFactor();
      const r = anchor.getBoundingClientRect();
      setPos(
        calculatePopoverPosition({
          anchor: r,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          width,
          align,
          zoom,
        }),
      );
    };
    update();
    // The capture-phase scroll listener fires for every scrollable container
    // (including the diff panel); coalesce to one reposition per frame so
    // scrolling with a popover open doesn't run rect reads per scroll event.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    // A UI zoom change lands as an inline-style mutation on #root (applyTheme)
    // and fires neither resize nor scroll, so observe the owner directly to
    // keep an open panel glued to its anchor at the new scale.
    const zoomOwner = document.getElementById('root');
    const zoomObserver = zoomOwner ? new MutationObserver(schedule) : null;
    if (zoomOwner) {
      zoomObserver?.observe(zoomOwner, { attributes: true, attributeFilter: ['style'] });
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      zoomObserver?.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [open, anchorRef, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    // Escape is handled by the shared module-level stack (usePopover.ts) so a
    // nested popover doesn't close both layers on a single keystroke.
    const pop = pushEscapeLayer(onClose);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
      pop();
    };
  }, [open, onClose, anchorRef]);

  // The portal escapes the trigger's DOM order, so Tab would otherwise walk
  // out of the open panel into whatever follows <body>; wrap focus instead.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || !trapFocus || e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) {
      // Every row can be disabled (e.g. subagent placeholders awaiting
      // registration); focus then rests on the panel itself and Tab must not
      // walk out of the open dialog into the page.
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open || !pos) return null;
  return createPortal(
    <div
      id={id}
      ref={panelRef}
      role={role}
      aria-label={label ?? 'Menu'}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        top: pos.top,
        bottom: pos.bottom,
        left: pos.left,
        transformOrigin: pos.top !== undefined ? 'top' : 'bottom',
      }}
      className={`z-[1000] transition-[opacity,transform] duration-150 ease-out ${
        entered ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
      }`}
    >
      <div
        style={{ zoom: pos.zoom, width: pos.width, maxHeight: pos.maxHeight }}
        className={`flex flex-col overflow-hidden rounded-xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/50 ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
