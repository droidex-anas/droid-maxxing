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

// Tombstones (archived/deleted) outlive preference metadata (pins, renames)
// under the cap: forgetting a preference is harmless, but forgetting a
// tombstone resurfaces a chat the user hid.
function isTombstone(meta: ChatMetadata): boolean {
  return meta.archivedAt !== undefined || meta.deletedAt !== undefined;
}

// Enforces MAX_TRACKED_CHATS on entries in recency order, dropping the oldest
// first and tombstones last. One rule for both seams — oversized payloads at
// load and runtime writes — so neither path can resurrect a hidden chat.
function capMetadataEntries(entries: [string, ChatMetadata][]): [string, ChatMetadata][] {
  if (entries.length <= MAX_TRACKED_CHATS) return entries;
  const byEvictionOrder = [
    ...entries.filter(([, meta]) => !isTombstone(meta)),
    ...entries.filter(([, meta]) => isTombstone(meta)),
  ];
  const dropped = new Set(
    byEvictionOrder.slice(0, entries.length - MAX_TRACKED_CHATS).map(([id]) => id),
  );
  return entries.filter(([id]) => !dropped.has(id));
}

export function loadChatMetadata(): ChatMetadataMap {
  try {
    const raw = getLocalStorage()?.getItem(CHAT_METADATA_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const entries: [string, ChatMetadata][] = [];
    for (const [appSessionId, value] of Object.entries(parsed)) {
      const meta = sanitizeMetadata(value);
      if (meta) entries.push([appSessionId, meta]);
    }
    // Storage order is recency (writes reinsert the touched id last); the cap
    // drops the oldest entries, tombstones last.
    return Object.fromEntries(capMetadataEntries(entries));
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

// The CLI titles a session started with a skill or slash command by the raw
// invocation ("/review src", "/btw …"), which reads as chrome instead of a
// name. Present the humanized command: "Review: src", "Btw". Titles that are
// not a bare command (paths like "/already/a/path") pass through untouched.
// Display-only by design: the stored title stays raw, so nothing is ever
// rewritten in the session file or caches and the original is recoverable.
function presentSlashCommandTitle(title: string): string {
  const command = /^\/\s*([\w-]+)(?:\s+(.*))?$/.exec(title.trim());
  if (!command) return title;
  // Index access types groups as plain strings; .at() is honest about the
  // optional args group being undefined for a bare command like "/review".
  const name = command[1];
  const rawArgs = command.at(2);
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  const args = rawArgs?.trim();
  return args ? `${label}: ${args}` : label;
}

// The title the UI shows: the user's override when present, else the
// harness-generated session title, with slash-command invocations humanized.
export function chatDisplayTitle(session: SessionSummary, meta: ChatMetadata | undefined): string {
  return presentSlashCommandTitle(meta?.displayTitle ?? session.title);
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
  return Object.fromEntries(capMetadataEntries(Object.entries(next)));
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
