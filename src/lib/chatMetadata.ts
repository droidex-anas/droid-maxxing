// App-level chat organization and naming: display title, pin, archive, and
// delete flags for sidebar chats. Keyed by appSessionId — the harness-minted
// session UUID — never by title, because the harness generates titles from
// the first prompt and identical prompts produce identical titles.
//
// - displayTitle overrides the generated title everywhere in the UI; the
//   stored override stays the source of truth across every harness;
// - pin moves a chat into the Pinned section at the top of the sidebar;
// - archive hides it from the sidebar (restorable from Settings > Archived);
// - delete tombstones it so it never appears in the app again.
//
// Everything persists in localStorage and survives restarts. Payloads loaded
// from storage are sanitized: a corrupt or bloated entry degrades to an empty
// map instead of breaking the sidebar.

import type { SessionSummary } from '../types/bridge';

export interface ChatMetadata {
  displayTitle?: string;
  pinnedAt?: number;
  archivedAt?: number;
  deletedAt?: number;
}

export type ChatMetadataMap = Record<string, ChatMetadata>;

const CHAT_METADATA_STORAGE_KEY = 'droid-chat-metadata';
// Bounds so a corrupt or ever-growing payload cannot bloat storage.
const MAX_TRACKED_CHATS = 1000;
export const MAX_CHAT_TITLE_LENGTH = 200;

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

function asTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeMetadata(value: unknown): ChatMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: ChatMetadata = {};
  if (typeof raw.displayTitle === 'string' && raw.displayTitle.trim().length > 0) {
    out.displayTitle = raw.displayTitle.trim().slice(0, MAX_CHAT_TITLE_LENGTH);
  }
  const pinnedAt = asTimestamp(raw.pinnedAt);
  const archivedAt = asTimestamp(raw.archivedAt);
  const deletedAt = asTimestamp(raw.deletedAt);
  if (pinnedAt !== undefined) out.pinnedAt = pinnedAt;
  if (archivedAt !== undefined) out.archivedAt = archivedAt;
  if (deletedAt !== undefined) out.deletedAt = deletedAt;
  return Object.keys(out).length > 0 ? out : null;
}

export function loadChatMetadata(): ChatMetadataMap {
  try {
    const raw = getLocalStorage()?.getItem(CHAT_METADATA_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: ChatMetadataMap = {};
    for (const [appSessionId, value] of Object.entries(parsed).slice(0, MAX_TRACKED_CHATS)) {
      const meta = sanitizeMetadata(value);
      if (meta) out[appSessionId] = meta;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveChatMetadata(map: ChatMetadataMap): void {
  try {
    getLocalStorage()?.setItem(CHAT_METADATA_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

// Hidden chats stay out of the normal sidebar, search, and the unread badge.
export function isChatHidden(meta: ChatMetadata | undefined): boolean {
  return meta?.archivedAt !== undefined || meta?.deletedAt !== undefined;
}

export function isChatPinned(meta: ChatMetadata | undefined): boolean {
  return meta?.pinnedAt !== undefined && !isChatHidden(meta);
}

// The title the UI shows: the user's override when present, else the
// harness-generated session title.
export function chatDisplayTitle(session: SessionSummary, meta: ChatMetadata | undefined): string {
  return meta?.displayTitle ?? session.title;
}

// Chats for the Pinned section: pinned and not hidden. Callers keep their
// usual recency ordering.
export function pinnedChats(
  sessions: SessionSummary[],
  metadata: ChatMetadataMap,
): SessionSummary[] {
  const byId: Partial<ChatMetadataMap> = metadata;
  return sessions.filter((session) => isChatPinned(byId[session.appSessionId]));
}

// Chats for the Archived settings view: archived but not deleted, most
// recently archived first.
export function archivedChats(
  sessions: SessionSummary[],
  metadata: ChatMetadataMap,
): { session: SessionSummary; archivedAt: number }[] {
  const byId: Partial<ChatMetadataMap> = metadata;
  const rows: { session: SessionSummary; archivedAt: number }[] = [];
  for (const session of sessions) {
    const meta = byId[session.appSessionId];
    if (meta?.archivedAt === undefined || meta.deletedAt !== undefined) continue;
    rows.push({ session, archivedAt: meta.archivedAt });
  }
  return rows.sort((a, b) => b.archivedAt - a.archivedAt);
}

// Replaces one chat's metadata, dropping the key entirely once nothing is
// stored for it so the map (and storage) stays free of empty entries.
function withMetadata(
  map: ChatMetadataMap,
  appSessionId: string,
  meta: ChatMetadata,
): ChatMetadataMap {
  const rest = Object.fromEntries(Object.entries(map).filter(([id]) => id !== appSessionId));
  const hasContent =
    meta.displayTitle !== undefined ||
    meta.pinnedAt !== undefined ||
    meta.archivedAt !== undefined ||
    meta.deletedAt !== undefined;
  const next = hasContent ? { ...rest, [appSessionId]: meta } : rest;
  // The same bound loadChatMetadata enforces on read, applied here so runtime
  // updates cannot grow storage past it between restarts. The touched id is
  // reinserted last, so insertion order is recency and the oldest drop first.
  const entries = Object.entries(next);
  return entries.length > MAX_TRACKED_CHATS
    ? Object.fromEntries(entries.slice(entries.length - MAX_TRACKED_CHATS))
    : next;
}

// The transforms below return null when nothing would change so the reducer
// can keep the current state (no re-render, no storage write).

// Sets the app-level display title. A blank title clears the override so the
// chat shows its harness-generated title again.
export function renameChat(
  map: ChatMetadataMap,
  appSessionId: string,
  title: string,
): ChatMetadataMap | null {
  const byId: Partial<ChatMetadataMap> = map;
  const meta = byId[appSessionId];
  const trimmed = title.trim().slice(0, MAX_CHAT_TITLE_LENGTH);
  if (trimmed.length === 0) {
    if (meta?.displayTitle === undefined) return null;
    return withMetadata(map, appSessionId, { ...meta, displayTitle: undefined });
  }
  if (meta?.displayTitle === trimmed) return null;
  return withMetadata(map, appSessionId, { ...meta, displayTitle: trimmed });
}

export function pinChat(
  map: ChatMetadataMap,
  appSessionId: string,
  now: number,
): ChatMetadataMap | null {
  const byId: Partial<ChatMetadataMap> = map;
  const meta = byId[appSessionId];
  // Hidden chats cannot be pinned; pinning is only offered on visible rows.
  if (isChatHidden(meta) || meta?.pinnedAt !== undefined) return null;
  return withMetadata(map, appSessionId, { ...meta, pinnedAt: now });
}

export function unpinChat(map: ChatMetadataMap, appSessionId: string): ChatMetadataMap | null {
  const byId: Partial<ChatMetadataMap> = map;
  const meta = byId[appSessionId];
  if (meta?.pinnedAt === undefined) return null;
  const next: ChatMetadata = {};
  if (meta.displayTitle !== undefined) next.displayTitle = meta.displayTitle;
  if (meta.archivedAt !== undefined) next.archivedAt = meta.archivedAt;
  if (meta.deletedAt !== undefined) next.deletedAt = meta.deletedAt;
  return withMetadata(map, appSessionId, next);
}

export function archiveChat(
  map: ChatMetadataMap,
  appSessionId: string,
  now: number,
): ChatMetadataMap | null {
  const byId: Partial<ChatMetadataMap> = map;
  const meta = byId[appSessionId];
  if (meta?.archivedAt !== undefined) return null;
  // Archiving a pinned chat unpins it: the Pinned section only lists visible
  // chats.
  const next: ChatMetadata = { archivedAt: now };
  if (meta?.displayTitle !== undefined) next.displayTitle = meta.displayTitle;
  if (meta?.deletedAt !== undefined) next.deletedAt = meta.deletedAt;
  return withMetadata(map, appSessionId, next);
}

export function restoreChat(map: ChatMetadataMap, appSessionId: string): ChatMetadataMap | null {
  const byId: Partial<ChatMetadataMap> = map;
  const meta = byId[appSessionId];
  if (meta?.archivedAt === undefined) return null;
  // archiveChat drops pinnedAt, so an archived chat never has a pin to carry.
  const next: ChatMetadata = {};
  if (meta.displayTitle !== undefined) next.displayTitle = meta.displayTitle;
  if (meta.deletedAt !== undefined) next.deletedAt = meta.deletedAt;
  return withMetadata(map, appSessionId, next);
}

export function deleteChat(
  map: ChatMetadataMap,
  appSessionId: string,
  now: number,
): ChatMetadataMap | null {
  const byId: Partial<ChatMetadataMap> = map;
  const meta = byId[appSessionId];
  if (meta?.deletedAt !== undefined) return null;
  const next: ChatMetadata = { deletedAt: now };
  if (meta?.displayTitle !== undefined) next.displayTitle = meta.displayTitle;
  if (meta?.archivedAt !== undefined) next.archivedAt = meta.archivedAt;
  return withMetadata(map, appSessionId, next);
}
