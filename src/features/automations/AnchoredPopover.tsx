import { motion, useReducedMotion } from 'framer-motion';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  calculatePopoverPosition,
  parseUiScale,
  samePopoverPosition,
  type PopoverPosition,
} from './popoverGeometry';

interface OpenPopover {
  id: string;
  close: () => void;
}

// Automation controls render through portals. Keeping one module-level owner is
// enough to guarantee that opening a second selector closes the first without
// making every editor row share React state.
let openPopover: OpenPopover | null = null;

export function AnchoredPopover({
  open,
  anchorRef,
  onClose,
  children,
  width = 300,
  align = 'end',
  gap = 8,
  maximumHeight = 420,
  className = '',
  ariaLabel,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  align?: 'start' | 'end';
  gap?: number;
  maximumHeight?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const positionFrame = useRef<number | null>(null);
  const focusFrame = useRef<number | null>(null);
  const panelHadFocus = useRef(false);
  const openRef = useRef(open);
  const popoverId = useId();
  const reduceMotion = useReducedMotion();
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  onCloseRef.current = onClose;
  openRef.current = open;

  const dismiss = useCallback(() => {
    if (!openRef.current) return;
    onCloseRef.current();
  }, []);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const viewport = window.visualViewport;
    // Client rectangles are viewport pixels while the panel lives inside the
    // zoomed UI root, so every measurement is converted into the root's scale.
    const scale = parseUiScale(window.getComputedStyle(popoverHost()).zoom);
    const next = calculatePopoverPosition({
      anchor: {
        left: anchor.left / scale,
        right: anchor.right / scale,
        top: anchor.top / scale,
        bottom: anchor.bottom / scale,
      },
      viewportWidth: (viewport?.width ?? window.innerWidth) / scale,
      viewportHeight: (viewport?.height ?? window.innerHeight) / scale,
      // `offsetHeight` is already scaled by the root zoom. The menu body owns
      // its own scroll container, so measuring the outer rendered box avoids
      // forcing layout across the virtual spacer used by long catalogs.
      measuredHeight: panel.offsetHeight || maximumHeight,
      requestedWidth: width,
      align,
      gap,
      maximumHeight,
    });
    setPosition((current) => (samePopoverPosition(current, next) ? current : next));
  }, [align, anchorRef, gap, maximumHeight, width]);

  const requestPosition = useCallback(() => {
    if (positionFrame.current !== null) return;
    positionFrame.current = window.requestAnimationFrame(() => {
      positionFrame.current = null;
      if (openRef.current) updatePosition();
    });
  }, [updatePosition]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    // Register and close the previous selector before paint, so two portal
    // panels never overlap for a frame when the user moves between rows.
    if (openPopover && openPopover.id !== popoverId) openPopover.close();
    const registration: OpenPopover = { id: popoverId, close: dismiss };
    openPopover = registration;

    // Layout effects run before paint, so the portal never flashes at 0,0 or
    // stretches over the drawer while geometry is being calculated. The menu
    // has fixed internal scroll bounds; one synchronous measurement is enough.
    updatePosition();
    return () => {
      if (openPopover === registration) openPopover = null;
    };
  }, [dismiss, open, popoverId, updatePosition]);

  useEffect(() => {
    if (!open) return;

    // The anchor outlives the panel, so it is safe to keep for the cleanup that
    // returns focus after the portal is gone.
    const anchor = anchorRef.current;
    panelHadFocus.current = containsActiveElement(panelRef.current);
    const isInside = (event: Event) =>
      eventPathContains(event, anchorRef.current) || eventPathContains(event, panelRef.current);
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event)) dismiss();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (eventPathContains(event, panelRef.current)) panelHadFocus.current = true;
      if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
      focusFrame.current = window.requestAnimationFrame(() => {
        focusFrame.current = null;
        if (!openRef.current) return;
        const focused = document.activeElement;
        if (
          focused instanceof Node &&
          !anchorRef.current?.contains(focused) &&
          !panelRef.current?.contains(focused)
        ) {
          dismiss();
        }
      });
    };
    const onContextMenu = (event: MouseEvent) => {
      if (!isInside(event)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    const onScroll = (event: Event) => {
      // Scrolling inside a large timezone/model menu does not move its anchor,
      // so it must not trigger a new layout pass for every scroll tick.
      if (eventPathContains(event, panelRef.current)) return;
      requestPosition();
    };
    const onWindowBlur = () => {
      dismiss();
    };
    // Content that arrives after opening (a model catalog finishing its load)
    // changes the panel height, which can flip its side or free extra room.
    const panelResize = new ResizeObserver(requestPosition);
    if (panelRef.current) panelResize.observe(panelRef.current);

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', requestPosition);
    window.addEventListener('blur', onWindowBlur);
    window.visualViewport?.addEventListener('resize', requestPosition);
    window.visualViewport?.addEventListener('scroll', requestPosition);
    return () => {
      panelResize.disconnect();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', requestPosition);
      window.removeEventListener('blur', onWindowBlur);
      window.visualViewport?.removeEventListener('resize', requestPosition);
      window.visualViewport?.removeEventListener('scroll', requestPosition);
      // The panel is already unmounted here, so a close that started inside it
      // (Escape, Done, choosing an option) left focus on the document body.
      if (panelHadFocus.current && document.activeElement === document.body) {
        anchor?.focus({ preventScroll: true });
      }
      panelHadFocus.current = false;
    };
  }, [anchorRef, dismiss, open, requestPosition]);

  useEffect(
    () => () => {
      if (positionFrame.current !== null) window.cancelAnimationFrame(positionFrame.current);
      if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
    },
    [],
  );

  if (typeof document === 'undefined') return null;

  if (!open) return null;

  return createPortal(
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      data-automation-popover
      initial={reduceMotion ? false : { opacity: 0, y: -3, scale: 0.995 }}
      animate={{
        opacity: position ? 1 : 0,
        y: 0,
        scale: 1,
      }}
      transition={{ duration: reduceMotion ? 0 : 0.11, ease: [0.16, 1, 0.3, 1] }}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        width: position?.width ?? Math.min(width, window.innerWidth - 20),
        maxHeight: position?.maxHeight,
        visibility: position ? 'visible' : 'hidden',
        pointerEvents: position ? 'auto' : 'none',
        transformOrigin:
          position?.placement === 'above'
            ? align === 'end'
              ? 'bottom right'
              : 'bottom left'
            : align === 'end'
              ? 'top right'
              : 'top left',
        // Fully opaque themed surface: drawer rows must never bleed through a
        // timezone/model menu while it opens.
        backgroundColor: 'var(--droid-bg)',
        isolation: 'isolate',
        overscrollBehavior: 'contain',
        contain: 'layout paint',
        willChange: reduceMotion ? undefined : 'transform, opacity',
      }}
      className={`pointer-events-auto fixed z-[260] overflow-hidden rounded-2xl border border-droid-border shadow-2xl shadow-black/45 ${className}`}
    >
      {children}
    </motion.div>,
    popoverHost(),
  );
}

// Mounting inside the zoomed UI root instead of <body> is what makes automation
// menus follow the UI font-size setting.
function popoverHost(): HTMLElement {
  return document.getElementById('root') ?? document.body;
}

function containsActiveElement(node: Node | null): boolean {
  const focused = document.activeElement;
  return Boolean(node && focused instanceof Node && node.contains(focused));
}

function eventPathContains(event: Event, node: Node | null): boolean {
  if (!node) return false;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  if (path.length > 0) return path.includes(node);
  return event.target instanceof Node && node.contains(event.target);
}
