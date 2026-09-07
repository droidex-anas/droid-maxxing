import {
  captureViewportAnchor,
  restoreViewportAnchor,
  type ConversationViewportLayout,
  type ViewportAnchor,
} from './conversationViewportAnchor';

export const TOP_AUTO_LOAD_PX = 600;
const MAX_SCROLL_SNAPSHOTS = 100;

export type ScrollDispatch = (
  action:
    | { type: 'TRANSCRIPT_VIEWPORT'; appSessionId: string; pinned: boolean }
    | { type: 'TRANSCRIPT_RELEASE_VIEWPORT'; appSessionId: string }
    | { type: 'SESSION_HISTORY_LOADING_OLDER'; appSessionId: string }
    | {
        type: 'CHILD_HISTORY_LOADING_OLDER';
        parentAppSessionId: string;
        childSessionId: string;
      }
    | {
        type: 'CHILD_TRANSCRIPT_VIEWPORT';
        parentAppSessionId: string;
        childSessionId: string;
        pinned: boolean;
      }
    | {
        type: 'CHILD_TRANSCRIPT_RELEASE_VIEWPORT';
        parentAppSessionId: string;
        childSessionId: string;
      },
) => void;

export interface PendingHistoryPrepend {
  conversationKey: string;
  requestedCursor: string;
  transcriptLength: number;
}

export interface ScrollSnapshot {
  top: number;
  pinned: boolean;
  anchor: ViewportAnchor | null;
}

export function rememberScrollSnapshot(
  snapshots: Map<string, ScrollSnapshot>,
  conversationKey: string | null,
  snapshot: ScrollSnapshot,
): void {
  if (!conversationKey) return;
  snapshots.delete(conversationKey);
  snapshots.set(conversationKey, snapshot);
  while (snapshots.size > MAX_SCROLL_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (typeof oldest !== 'string') return;
    snapshots.delete(oldest);
  }
}

export function restoreConversationScrollSnapshot(
  element: HTMLDivElement,
  snapshot: ScrollSnapshot | undefined,
  layout?: ConversationViewportLayout | null,
): { pinned: boolean; anchor: ViewportAnchor | null } {
  const pinned = snapshot?.pinned ?? true;
  element.scrollTop = snapshot?.top ?? element.scrollHeight;
  if (pinned) return { pinned, anchor: null };
  const anchor = snapshot?.anchor
    ? restoreViewportAnchor(element, snapshot.anchor, true, layout).anchor
    : captureViewportAnchor(element, true);
  return { pinned, anchor };
}

export function shouldReportPinnedViewport(
  reported: { conversationKey: string; pinned: boolean } | null,
  conversationKey: string,
  pinned: boolean,
): boolean {
  if (!reported) return true;
  return reported.conversationKey !== conversationKey || reported.pinned !== pinned;
}

export function pinnedViewportAction({
  appSessionId,
  childSessionId,
  pinned,
}: {
  appSessionId: string;
  childSessionId?: string;
  pinned: boolean;
}): Parameters<ScrollDispatch>[0] {
  if (childSessionId) {
    return {
      type: 'CHILD_TRANSCRIPT_VIEWPORT',
      parentAppSessionId: appSessionId,
      childSessionId,
      pinned,
    };
  }
  return {
    type: 'TRANSCRIPT_VIEWPORT',
    appSessionId,
    pinned,
  };
}

export function shouldReleaseConversationTranscript(options: {
  isConversationLive: boolean;
  isLoadingOlder: boolean;
  isAutoPagingOlderHistory: boolean;
  isPinned: boolean;
}): boolean {
  return (
    !options.isConversationLive &&
    !options.isLoadingOlder &&
    !options.isAutoPagingOlderHistory &&
    options.isPinned
  );
}

// Older history loads only once the reader has settled near the top: close
// enough to want more, with no page already on the way.
export function shouldLoadOlderHistoryAtTop(options: {
  scrollTop: number;
  hasOlderCursor: boolean;
  isLoadingOlder: boolean;
}): boolean {
  return options.hasOlderCursor && !options.isLoadingOlder && options.scrollTop < TOP_AUTO_LOAD_PX;
}

export function didCommitRequestedHistoryPrepend({
  requestedCursor,
  currentCursor,
  previousTranscriptLength,
  transcriptLength,
}: {
  requestedCursor: string;
  currentCursor: string | undefined;
  previousTranscriptLength: number;
  transcriptLength: number;
}): boolean {
  return requestedCursor !== currentCursor && transcriptLength > previousTranscriptLength;
}

export function applyConversationContentResize(
  element: HTMLDivElement,
  anchor: ViewportAnchor | null,
  isPinned: boolean,
  allowHeightFallback: boolean,
  layout?: ConversationViewportLayout | null,
):
  | { mode: 'follow-tail' | 'ignore'; anchor: ViewportAnchor | null; didFindRow: false }
  | { mode: 'preserve-anchor'; anchor: ViewportAnchor; didFindRow: boolean } {
  if (isPinned) {
    element.scrollTop = element.scrollHeight;
    return { mode: 'follow-tail', anchor, didFindRow: false };
  }
  if (anchor === null) return { mode: 'ignore', anchor, didFindRow: false };
  const restored = restoreViewportAnchor(element, anchor, allowHeightFallback, layout);
  return { mode: 'preserve-anchor', ...restored };
}

export interface ConversationContentResizeBinding {
  element: HTMLDivElement;
  content: Element;
  conversationKey: string | null;
}

/**
 * The observer must follow the scroll container's live first child. That child
 * is swapped for empty-transcript states (welcome, restore, compose skeleton)
 * and keyed transcript swaps, so content identity decides rebinding even while
 * the transcript length stays zero.
 */
export function shouldBindConversationContentResize(options: {
  binding: ConversationContentResizeBinding | null;
  element: HTMLDivElement | null;
  content: Element | null;
  conversationKey: string | null;
}): boolean {
  if (!options.element || !options.content) return false;
  return (
    options.binding?.element !== options.element ||
    options.binding.content !== options.content ||
    options.binding.conversationKey !== options.conversationKey
  );
}

export interface DisclosureAnchor {
  element: HTMLElement;
  viewportTop: number;
  expiresAt: number;
}

// Long enough to cover the 240 ms expand transition plus a few frames of
// chunked body mounts; refreshed while resizes keep arriving.
const DISCLOSURE_ANCHOR_MS = 900;
const DISCLOSURE_SETTLE_MS = 400;

/**
 * A disclosure the reader just clicked owns the viewport while it opens or
 * closes: the header they aimed at stays put instead of the feed snapping to
 * the tail or restoring a prose anchor behind their back. Captured during the
 * click's capture phase, before React applies the toggle.
 */
export function captureDisclosureAnchor(
  container: HTMLElement,
  button: HTMLElement | null,
  now: number,
): DisclosureAnchor | null {
  if (!button || !container.contains(button)) return null;
  return {
    element: button,
    viewportTop: button.getBoundingClientRect().top - container.getBoundingClientRect().top,
    expiresAt: now + DISCLOSURE_ANCHOR_MS,
  };
}

export type DisclosureAnchorAction =
  | { mode: 'release' }
  | { mode: 'hold' }
  | { mode: 'adjust'; delta: number };

// Chunked body mounts keep resizing after the first adjustment; each applied
// adjustment extends the anchor's life until the panel settles.
export function touchDisclosureAnchor(anchor: DisclosureAnchor, now: number): void {
  anchor.expiresAt = now + DISCLOSURE_SETTLE_MS;
}

/**
 * The scrollTop adjustment that keeps the clicked disclosure's header at its
 * captured viewport position. `hold` when the header did not move (growth
 * landed below it), `release` when the anchor expired or its element left the
 * DOM, `adjust` with the pixel delta otherwise.
 */
export function disclosureAnchorDelta(
  container: HTMLElement,
  anchor: DisclosureAnchor,
  now: number,
): DisclosureAnchorAction {
  if (now > anchor.expiresAt || !anchor.element.isConnected) return { mode: 'release' };
  const viewportTop =
    anchor.element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const delta = viewportTop - anchor.viewportTop;
  return Math.abs(delta) <= 0.5 ? { mode: 'hold' } : { mode: 'adjust', delta };
}

export function shouldCompensateConversationContentResize(options: {
  isPinned: boolean;
  isSettlingHistoryPrepend: boolean;
  isUserScrolling: boolean;
}): boolean {
  return options.isPinned || options.isSettlingHistoryPrepend || !options.isUserScrolling;
}

export function deferredViewportRestoreAction(
  currentGeneration: number,
  restoreGeneration: number,
  shouldRetryAnchor: boolean,
): 'skip' | 'retry' | 'release' {
  if (currentGeneration !== restoreGeneration) return 'skip';
  return shouldRetryAnchor ? 'retry' : 'release';
}
