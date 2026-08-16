// Lazy session transcript reader.
//
// Opening a session must not parse a multi-MB JSONL file upfront: the reader
// indexes line byte-offsets across the whole file, then preads and JSON.parses
// lines backward, newest first, only as far as each requested window needs.
// Paging older history parses a few hundred more lines per page instead of
// re-reading the whole file, and the bounded per-line parse memo makes repeat
// pages and reopens cheap. Because offsets are absolute, every message of an
// arbitrarily large session stays reachable by cursor.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { open as openAsync, readFile as readFileAsync } from 'node:fs/promises';
import {
  event,
  parseSessionLineEvents,
  type StoredMessageLine,
  type StoredSessionStart,
} from './sessionTranscriptParser.js';
import type { SessionRole, TranscriptEvent } from './protocol.js';

// Stored-row shapes are owned by the parser module but re-exported here so
// the history path's import stays stable.
export type { StoredMessageLine, StoredSessionStart } from './sessionTranscriptParser.js';

// Byte cap for the EAGER readers only (transcript search and the legacy
// history.page full parse): they materialize file text, so oversized files
// are tail-windowed. The lazy SessionTranscriptReader has no such cap.
export const MAX_SESSION_BYTES = 5_000_000;
// seq band per line: a line yields one event per content block, so (line,
// event-in-line) maps to a unique, stable, monotonically increasing seq
// within a segment. 256 far exceeds any real message's block count; a freak
// line with more blocks clamps onto the last band slot (order within that
// line is then kept by array order, not seq).
const LINE_EVENT_STRIDE = 256;
// Chunk size for the constructor's newline scan.
const LINE_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
// Bound on memoized parsed lines: paging deep into a huge session must not
// accumulate its entire parsed transcript in sidecar memory. Eviction is
// insertion-ordered and only costs a re-parse on revisit; 4,096 lines
// comfortably covers the largest history page plus scroll locality.
const MAX_MEMOIZED_LINES = 4_096;

// A position inside one segment's event stream: the next line to parse
// walking backward, plus how many of that line's tail events were already
// served (a page boundary can split one line's events across pages).
export interface TranscriptWindowCursor {
  line: number;
  skip: number;
}

// One shared, lazily-opened file descriptor per backward walk.
interface LazyFile {
  fd: number | null;
}

// Read the bytes an EAGER transcript parse can see: the whole file, or the
// newest MAX_SESSION_BYTES tail for oversized files (the partial first line
// of the window is dropped).
export function readSessionRawWindow(
  path: string,
  size: number,
): { text: string; trimmed: boolean } {
  if (size <= MAX_SESSION_BYTES) return { text: readFileSync(path, 'utf8'), trimmed: false };
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SESSION_BYTES);
    readSync(fd, buffer, 0, MAX_SESSION_BYTES, size - MAX_SESSION_BYTES);
    const raw = buffer.toString('utf8');
    const firstNewline = raw.indexOf('\n');
    return {
      text: firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw,
      trimmed: true,
    };
  } finally {
    closeSync(fd);
  }
}

// Async twin of readSessionRawWindow for callers that must not block the
// event loop (transcript content search answers bridge commands inline).
export async function readSessionRawWindowAsync(
  path: string,
  size: number,
): Promise<{ text: string; trimmed: boolean }> {
  if (size <= MAX_SESSION_BYTES) {
    return { text: await readFileAsync(path, 'utf8'), trimmed: false };
  }
  const handle = await openAsync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SESSION_BYTES);
    await handle.read(buffer, 0, MAX_SESSION_BYTES, size - MAX_SESSION_BYTES);
    const raw = buffer.toString('utf8');
    const firstNewline = raw.indexOf('\n');
    return {
      text: firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw,
      trimmed: true,
    };
  } finally {
    await handle.close();
  }
}

// Full eager parse of one session file, including the oversized-trim status
// head. Used by the provider-scoped history.page path, which slices a
// materialized event array by item index and so cannot window lazily.
export function parseFullSessionTranscript(
  appSessionId: string,
  providerSessionId: string,
  path: string,
  role: SessionRole,
): TranscriptEvent[] {
  const stat = statSync(path);
  const window = readSessionRawWindow(path, stat.size);
  const events: TranscriptEvent[] = [];
  if (window.trimmed) {
    events.push(oversizedStatusEvent(appSessionId, providerSessionId, role, stat.mtimeMs));
  }
  for (const raw of window.text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      events.push(
        ...parseSessionLineEvents(
          appSessionId,
          providerSessionId,
          role,
          JSON.parse(trimmed) as StoredMessageLine | StoredSessionStart,
        ),
      );
    } catch {
      /* skip partial/corrupt JSONL rows */
    }
  }
  return events;
}

// Byte offset of every line start in the file, bounded to `size` so bytes
// appended after the stat are ignored (the reader cache re-keys on stat).
// The scan is synchronous and O(file size), and the cache re-keys on every
// append, so a live session pays it again on the next window request. That is
// milliseconds for the tens-of-MB sessions this app produces; if sessions ever
// reach GB scale this must move off the event loop or cap the indexed range.
function scanLineStarts(path: string, size: number): number[] {
  if (size <= 0) return [];
  const starts = [0];
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, LINE_SCAN_CHUNK_BYTES));
    let position = 0;
    while (position < size) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytes <= 0) break;
      const chunk = buffer.subarray(0, bytes);
      let newline = chunk.indexOf(10 /* \n */);
      while (newline !== -1) {
        const next = position + newline + 1;
        if (next < size) starts.push(next);
        newline = chunk.indexOf(10, newline + 1);
      }
      position += bytes;
    }
  } finally {
    closeSync(fd);
  }
  return starts;
}

// One chain segment's transcript, parsed lazily from the tail. Construction
// scans the file once for line offsets; each window preads and parses only
// the lines it needs, walking backward from a cursor, so the first page of a
// huge session parses a few hundred lines instead of the whole file. Line
// indices are absolute file positions, which keeps cursors stable while the
// session is appended to.
export class SessionTranscriptReader {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  private readonly lineStarts: number[];
  private readonly parsedLines = new Map<number, TranscriptEvent[]>();

  constructor(
    private readonly appSessionId: string,
    private readonly providerSessionId: string,
    private readonly path: string,
    private readonly role: SessionRole,
  ) {
    const stat = statSync(path);
    this.mtimeMs = stat.mtimeMs;
    this.sizeBytes = stat.size;
    this.lineStarts = scanLineStarts(path, stat.size);
  }

  // Serve up to `limit` events ending at `from` (or the segment tail),
  // walking backward. Returned events are in forward (chronological) order
  // with seq = seqBase + segment-local position. `older` is set when the
  // segment still has unserved events below the returned page.
  windowBackward(
    limit: number,
    seqBase: number,
    from?: TranscriptWindowCursor,
  ): { events: TranscriptEvent[]; older?: TranscriptWindowCursor } {
    if (this.lineStarts.length === 0) return { events: [] };
    // The fd opens lazily on the first memo miss and is shared across the
    // walk, so a fully-memoized repeat page never touches the file.
    const file: LazyFile = { fd: null };
    let collected: TranscriptEvent[];
    let older: TranscriptWindowCursor | undefined;
    try {
      ({ collected, older } = this.collectBackward(file, limit, from));
    } finally {
      if (file.fd !== null) closeSync(file.fd);
    }
    collected.reverse();
    return {
      events: collected.map((e) => ({ ...e, seq: seqBase + (e.seq ?? 0) })),
      ...(older ? { older } : {}),
    };
  }

  // Walk lines backward from `from` (or the tail), collecting up to `limit`
  // events newest-first. `older` addresses the first unserved event.
  private collectBackward(
    file: LazyFile,
    limit: number,
    from?: TranscriptWindowCursor,
  ): { collected: TranscriptEvent[]; older?: TranscriptWindowCursor } {
    const collected: TranscriptEvent[] = []; // newest first
    let line = from ? from.line : this.lineStarts.length - 1;
    let skip = from?.skip ?? 0;
    while (line >= 0 && collected.length < limit) {
      const events = this.parseLine(file, line); // forward order within the line
      const available = events.length - skip;
      const take = Math.min(available, limit - collected.length);
      for (let i = available - 1; i >= available - take; i--) collected.push(events[i]);
      if (take < available) {
        return { collected, older: { line, skip: skip + take } };
      }
      line -= 1;
      skip = 0;
    }
    return {
      collected,
      // When the limit landed exactly on a line boundary, unserved events
      // remain below `line`.
      ...(line >= 0 ? { older: { line, skip: 0 } } : {}),
    };
  }

  private parseLine(file: LazyFile, index: number): TranscriptEvent[] {
    const hit = this.parsedLines.get(index);
    if (hit) return hit;
    // A cursor minted against a since-rewritten (compacted) file can address
    // lines past the end; serve nothing for them instead of a wrong page.
    if (index >= this.lineStarts.length) return [];
    const start = this.lineStarts[index];
    const end = index + 1 < this.lineStarts.length ? this.lineStarts[index + 1] : this.sizeBytes;
    let events: TranscriptEvent[] = [];
    if (end > start) {
      file.fd ??= openSync(this.path, 'r');
      const buffer = Buffer.alloc(end - start);
      readSync(file.fd, buffer, 0, end - start, start);
      const raw = buffer.toString('utf8').trim();
      if (raw) {
        try {
          events = parseSessionLineEvents(
            this.appSessionId,
            this.providerSessionId,
            this.role,
            JSON.parse(raw) as StoredMessageLine | StoredSessionStart,
          );
        } catch {
          /* skip partial/corrupt JSONL rows */
        }
      }
    }
    const base = (index + 1) * LINE_EVENT_STRIDE;
    events.forEach((e, i) => {
      e.seq = base + Math.min(i, LINE_EVENT_STRIDE - 1);
    });
    this.parsedLines.set(index, events);
    if (this.parsedLines.size > MAX_MEMOIZED_LINES) {
      const oldest = this.parsedLines.keys().next().value;
      if (oldest !== undefined) this.parsedLines.delete(oldest);
    }
    return events;
  }
}

function oversizedStatusEvent(
  appSessionId: string,
  providerSessionId: string,
  role: SessionRole,
  mtimeMs: number,
): TranscriptEvent {
  return event(
    {
      appSessionId,
      sourceProviderSessionId: providerSessionId,
      role,
      messageId: 'history-window',
      ts: mtimeMs,
    },
    0,
    'status',
    {
      text: `Loaded latest ${String(Math.round(MAX_SESSION_BYTES / 1_000_000))} MB of this oversized session for UI performance.`,
    },
  );
}
