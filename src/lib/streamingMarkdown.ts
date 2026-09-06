import {
  closesFence,
  continuesList,
  interruptsList,
  interruptsParagraph,
  isAtxHeading,
  isBlank,
  isBlockquote,
  isClosedLine,
  isSetextUnderline,
  isTableDelimiter,
  isThematicBreak,
  iterateLines,
  listItemIndent,
  looksLikeTableRow,
  nextNonBlank,
  openingFence,
  type OpenFence,
  type SourceLine,
} from './markdownBlockScan';

export { pendingFenceBody } from './markdownBlockScan';

export type StreamingBlockKind =
  | 'paragraph'
  | 'heading'
  | 'fence'
  | 'list'
  | 'table'
  | 'blockquote'
  | 'thematicBreak'
  | 'html';

export type PendingKind =
  | 'empty'
  | 'paragraph'
  | 'fence'
  | 'list'
  | 'table'
  | 'blockquote'
  | 'other';

export interface StreamingBlock {
  id: string;
  kind: StreamingBlockKind;
  source: string;
  fenceInfo?: string;
}

export interface StreamingDocument {
  completedBlocks: readonly StreamingBlock[];
  pendingSource: string;
  pendingKind: PendingKind;
  pendingFenceInfo?: string;
}

export interface StreamingIngestStats {
  scannedChars: number;
  usedIncremental: boolean;
}

export interface StreamingIngestResult {
  document: StreamingDocument;
  stats: StreamingIngestStats;
}

export const EMPTY_STREAMING_DOCUMENT: StreamingDocument = {
  completedBlocks: [],
  pendingSource: '',
  pendingKind: 'empty',
};

export function completedSourceOf(document: StreamingDocument): string {
  let source = '';
  for (const block of document.completedBlocks) source += block.source;
  return source;
}

export function ingestStreamingMarkdown(
  previous: { source: string; document: StreamingDocument } | null,
  source: string,
): StreamingIngestResult {
  if (previous) {
    const prefix = completedSourceOf(previous.document);
    if (prefix.length > 0 && source.startsWith(prefix)) {
      const pending = source.slice(prefix.length);
      const absorbed = absorbLeadingBlanks(
        previous.document.completedBlocks,
        pending,
        prefix.length,
      );
      const split = freezeCompletedPrefix(absorbed.pending, absorbed.nextOffset);
      return {
        document: {
          completedBlocks: [...absorbed.blocks, ...split.completedBlocks],
          pendingSource: split.pendingSource,
          pendingKind: split.pendingKind,
          ...(split.pendingFenceInfo !== undefined
            ? { pendingFenceInfo: split.pendingFenceInfo }
            : {}),
        },
        stats: { scannedChars: pending.length, usedIncremental: true },
      };
    }
  }
  const document = freezeCompletedPrefix(source, 0);
  return {
    document,
    stats: { scannedChars: source.length, usedIncremental: false },
  };
}

function absorbLeadingBlanks(
  blocks: readonly StreamingBlock[],
  pending: string,
  offset: number,
): { blocks: StreamingBlock[]; pending: string; nextOffset: number } {
  if (blocks.length === 0) return { blocks: [...blocks], pending, nextOffset: offset };
  const lines = iterateLines(pending);
  let index = 0;
  let consumed = 0;
  while (index < lines.length) {
    const line = lines.at(index);
    if (!line || !isClosedLine(line) || !isBlank(line.text)) break;
    consumed = line.end;
    index += 1;
  }
  if (consumed === 0) return { blocks: [...blocks], pending, nextOffset: offset };
  const last = blocks.at(-1);
  if (!last) return { blocks: [...blocks], pending, nextOffset: offset };
  const nextBlocks = blocks.slice(0, -1);
  nextBlocks.push({ ...last, source: last.source + pending.slice(0, consumed) });
  return {
    blocks: nextBlocks,
    pending: pending.slice(consumed),
    nextOffset: offset + consumed,
  };
}

export function freezeCompletedPrefix(source: string, idOffset = 0): StreamingDocument {
  if (source.length === 0) return EMPTY_STREAMING_DOCUMENT;
  const lines = iterateLines(source);
  const blocks: StreamingBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const taken = tryTakeBlock(lines, index);
    if (!taken) break;
    const startLine = lines.at(index);
    if (!startLine) break;
    const blockSource = source.slice(startLine.start, taken.end);
    const block: StreamingBlock = {
      id: `b:${String(idOffset + startLine.start)}`,
      kind: taken.kind,
      source: blockSource,
    };
    if (taken.fenceInfo !== undefined) block.fenceInfo = taken.fenceInfo;
    blocks.push(block);
    index = taken.nextIndex;
  }

  const firstPending = lines.at(index);
  const pendingSource = firstPending ? source.slice(firstPending.start) : '';
  const pending = classifyPending(pendingSource);
  return {
    completedBlocks: blocks,
    pendingSource,
    pendingKind: pending.kind,
    ...(pending.fenceInfo !== undefined ? { pendingFenceInfo: pending.fenceInfo } : {}),
  };
}

interface TakenBlock {
  kind: StreamingBlockKind;
  end: number;
  nextIndex: number;
  fenceInfo?: string;
}

function tryTakeBlock(lines: SourceLine[], index: number): TakenBlock | null {
  const line = lines.at(index);
  if (!line) return null;
  if (isBlank(line.text)) {
    if (!isClosedLine(line)) return null;
    return includeTrailingBlanks(lines, { kind: 'paragraph', end: line.end, nextIndex: index + 1 });
  }
  // Incomplete containers must stay pending — never fall through to a paragraph.
  if (listItemIndent(line.text) !== null) {
    return includeTrailingBlanks(lines, tryTakeList(lines, index));
  }
  if (openingFence(line.text)) return includeTrailingBlanks(lines, tryTakeFence(lines, index));
  if (isAtxHeading(line.text)) return includeTrailingBlanks(lines, tryTakeAtxHeading(lines, index));
  if (isThematicBreak(line.text)) {
    return includeTrailingBlanks(lines, tryTakeThematicBreak(lines, index));
  }
  if (looksLikeTableRow(line.text)) {
    const table = tryTakeTable(lines, index);
    if (table) return includeTrailingBlanks(lines, table);
    const next = lines.at(index + 1);
    if (!next || !isClosedLine(next) || isTableDelimiter(next.text) || isBlank(next.text)) {
      return null;
    }
  }
  if (isBlockquote(line.text)) return includeTrailingBlanks(lines, tryTakeBlockquote(lines, index));
  return includeTrailingBlanks(lines, tryTakeParagraph(lines, index));
}

function includeTrailingBlanks(lines: SourceLine[], taken: TakenBlock | null): TakenBlock | null {
  if (!taken) return null;
  let nextIndex = taken.nextIndex;
  let end = taken.end;
  while (nextIndex < lines.length) {
    const line = lines.at(nextIndex);
    if (!line || !isClosedLine(line) || !isBlank(line.text)) break;
    end = line.end;
    nextIndex += 1;
  }
  return nextIndex === taken.nextIndex && end === taken.end ? taken : { ...taken, end, nextIndex };
}

function tryTakeFence(lines: SourceLine[], index: number): TakenBlock | null {
  const line = lines.at(index);
  if (!line || !isClosedLine(line)) return null;
  const open = openingFence(line.text);
  if (!open) return null;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const candidate = lines.at(cursor);
    if (!candidate) return null;
    if (!isClosedLine(candidate)) return null;
    if (closesFence(candidate.text, open)) {
      return {
        kind: 'fence',
        end: candidate.end,
        nextIndex: cursor + 1,
        ...(open.info.length > 0 ? { fenceInfo: open.info } : {}),
      };
    }
  }
  return null;
}

function tryTakeAtxHeading(lines: SourceLine[], index: number): TakenBlock | null {
  const line = lines.at(index);
  if (!line || !isClosedLine(line) || !isAtxHeading(line.text)) return null;
  const next = lines.at(index + 1);
  if (next && isBlank(next.text) && isClosedLine(next)) {
    return { kind: 'heading', end: next.end, nextIndex: index + 2 };
  }
  return { kind: 'heading', end: line.end, nextIndex: index + 1 };
}

function tryTakeThematicBreak(lines: SourceLine[], index: number): TakenBlock | null {
  const line = lines.at(index);
  if (!line || !isClosedLine(line) || !isThematicBreak(line.text)) return null;
  return { kind: 'thematicBreak', end: line.end, nextIndex: index + 1 };
}

function tryTakeTable(lines: SourceLine[], index: number): TakenBlock | null {
  const header = lines.at(index);
  const delimiter = lines.at(index + 1);
  if (!header || !delimiter || !isClosedLine(header) || !isClosedLine(delimiter)) return null;
  if (!looksLikeTableRow(header.text) || !isTableDelimiter(delimiter.text)) return null;
  let last = index + 1;
  for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
    const row = lines.at(cursor);
    if (!row) break;
    if (!isClosedLine(row)) return null;
    if (isBlank(row.text) || !looksLikeTableRow(row.text)) {
      const lastLine = lines.at(last);
      if (!lastLine) return null;
      return {
        kind: 'table',
        end: isBlank(row.text) ? row.end : lastLine.end,
        nextIndex: isBlank(row.text) ? cursor + 1 : cursor,
      };
    }
    last = cursor;
  }
  return null;
}

function tryTakeList(lines: SourceLine[], index: number): TakenBlock | null {
  const first = lines.at(index);
  if (!first || !isClosedLine(first)) return null;
  const itemIndent = listItemIndent(first.text);
  if (itemIndent === null) return null;
  let openFence: OpenFence | null = openingFence(first.text);
  let last = index;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines.at(cursor);
    if (!line) return null;
    if (!isClosedLine(line)) return null;
    if (openFence) {
      if (closesFence(line.text, openFence)) openFence = null;
      last = cursor;
      continue;
    }
    const nestedFence = openingFence(line.text);
    if (nestedFence && continuesList(line.text, itemIndent)) {
      openFence = nestedFence;
      last = cursor;
      continue;
    }
    if (isBlank(line.text)) {
      const following = nextNonBlank(lines, cursor + 1);
      if (!following) return null;
      if (!isClosedLine(following.line)) return null;
      if (continuesList(following.line.text, itemIndent)) {
        last = cursor;
        continue;
      }
      return { kind: 'list', end: line.end, nextIndex: following.index };
    }
    if (continuesList(line.text, itemIndent)) {
      last = cursor;
      continue;
    }
    if (interruptsList(line.text)) {
      return { kind: 'list', end: lines.at(last)?.end ?? first.end, nextIndex: cursor };
    }
    return null;
  }
  return null;
}

function tryTakeBlockquote(lines: SourceLine[], index: number): TakenBlock | null {
  const first = lines.at(index);
  if (!first || !isClosedLine(first) || !isBlockquote(first.text)) return null;
  let last = index;
  let openFence: OpenFence | null = openingFence(first.text);
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines.at(cursor);
    if (!line) return null;
    if (!isClosedLine(line)) return null;
    if (openFence) {
      if (closesFence(line.text, openFence)) openFence = null;
      last = cursor;
      continue;
    }
    if (isBlank(line.text)) {
      const following = nextNonBlank(lines, cursor + 1);
      if (!following) return null;
      if (!isClosedLine(following.line)) return null;
      if (isBlockquote(following.line.text)) {
        last = cursor;
        continue;
      }
      return { kind: 'blockquote', end: line.end, nextIndex: following.index };
    }
    const nestedFence = openingFence(line.text);
    if (nestedFence && isBlockquote(line.text)) {
      openFence = nestedFence;
      last = cursor;
      continue;
    }
    if (isBlockquote(line.text)) {
      last = cursor;
      continue;
    }
    if (interruptsList(line.text)) {
      return { kind: 'blockquote', end: lines.at(last)?.end ?? first.end, nextIndex: cursor };
    }
    return null;
  }
  return null;
}

function tryTakeParagraph(lines: SourceLine[], index: number): TakenBlock | null {
  const first = lines.at(index);
  if (!first || !isClosedLine(first)) return null;
  let last = index;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines.at(cursor);
    if (!line) return null;
    if (!isClosedLine(line)) return null;
    if (isBlank(line.text)) {
      return { kind: 'paragraph', end: line.end, nextIndex: cursor + 1 };
    }
    if (isSetextUnderline(line.text) && last === index) {
      const after = lines.at(cursor + 1);
      if (after && isBlank(after.text) && isClosedLine(after)) {
        return { kind: 'heading', end: after.end, nextIndex: cursor + 2 };
      }
      return { kind: 'heading', end: line.end, nextIndex: cursor + 1 };
    }
    if (interruptsParagraph(line.text)) {
      return { kind: 'paragraph', end: lines.at(last)?.end ?? first.end, nextIndex: cursor };
    }
    last = cursor;
  }
  return null;
}

function classifyPending(pending: string): { kind: PendingKind; fenceInfo?: string } {
  if (pending.length === 0) return { kind: 'empty' };
  const first = iterateLines(pending).at(0);
  if (!first) return { kind: 'empty' };
  let text = first.text;
  if (isBlank(text)) {
    const rest = iterateLines(pending).find((line) => !isBlank(line.text));
    if (!rest) return { kind: 'other' };
    text = rest.text;
  }
  const fence = openingFence(text);
  if (fence) return { kind: 'fence', ...(fence.info.length > 0 ? { fenceInfo: fence.info } : {}) };
  if (listItemIndent(text) !== null) return { kind: 'list' };
  if (isBlockquote(text)) return { kind: 'blockquote' };
  if (looksLikeTableRow(text)) return { kind: 'table' };
  if (isAtxHeading(text) || isThematicBreak(text)) return { kind: 'other' };
  return { kind: 'paragraph' };
}
