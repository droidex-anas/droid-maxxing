import { createContext, useContext, type ReactNode } from 'react';

import {
  EMPTY_CONVERSATION_VISIBLE_RANGE,
  type ConversationVisibleRange,
} from './conversationListState';

const VisibleRangeContext = createContext<ConversationVisibleRange>(
  EMPTY_CONVERSATION_VISIBLE_RANGE,
);
const RowIdContext = createContext<string | null>(null);

export function ConversationVisibilityProvider({
  range,
  children,
}: {
  range: ConversationVisibleRange;
  children: ReactNode;
}) {
  return <VisibleRangeContext.Provider value={range}>{children}</VisibleRangeContext.Provider>;
}

export function ConversationRowScope({ rowId, children }: { rowId: string; children: ReactNode }) {
  return <RowIdContext.Provider value={rowId}>{children}</RowIdContext.Provider>;
}

export function useHeavyRendererAllowed(): boolean {
  const range = useContext(VisibleRangeContext);
  const rowId = useContext(RowIdContext);
  if (rowId === null) return true;
  if (range.rowIds.length === 0 && range.nearRowIds.length === 0) return true;
  return range.rowIds.includes(rowId) || range.nearRowIds.includes(rowId);
}
