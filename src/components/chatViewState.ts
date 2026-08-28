import type { AppState } from '../hooks/useStore';

const EMPTY_TRANSCRIPT: never[] = [];

export function selectChatViewState(current: AppState) {
  const activeSession = current.activeAppSessionId
    ? current.sessions[current.activeAppSessionId]
    : null;
  return {
    activeSession,
    allTranscript: activeSession
      ? (current.transcripts[activeSession.appSessionId] ?? EMPTY_TRANSCRIPT)
      : EMPTY_TRANSCRIPT,
    transcriptMutation: activeSession
      ? current.transcriptMutations[activeSession.appSessionId]
      : undefined,
    chatMetadata: current.chatMetadata,
    childAccess: current.childAccess,
    childHistory: current.childHistory,
    childSessions: current.childSessions,
    draftChat: current.draftChat,
    historyCursor: current.historyCursor,
    historyLoadingOlder: current.historyLoadingOlder,
    models: current.models,
    pendingCompose: current.pendingCompose,
    selectedChild: current.selectedChild,
    sessionRestore: current.sessionRestore,
    sessionSpecs: current.sessionSpecs,
    specPlans: current.specPlans,
    transcriptRetainedCost: current.transcriptRetainedCost,
  };
}

export type ChatViewState = ReturnType<typeof selectChatViewState>;

function equalActiveChatSession(
  previous: ChatViewState['activeSession'],
  next: ChatViewState['activeSession'],
): boolean {
  return (
    previous === next ||
    (previous?.appSessionId === next?.appSessionId &&
      previous?.createdAt === next?.createdAt &&
      previous?.cwd === next?.cwd &&
      previous?.configuration.interactionMode === next?.configuration.interactionMode &&
      previous?.title === next?.title &&
      previous?.interruptReason === next?.interruptReason)
  );
}

function equalChildSelection(
  previous: AppState['selectedChild'],
  next: AppState['selectedChild'],
): boolean {
  return (
    previous === next ||
    (previous?.parentAppSessionId === next?.parentAppSessionId &&
      previous?.childSessionId === next?.childSessionId)
  );
}

function latestPendingCompose(state: ChatViewState) {
  return Object.values(state.pendingCompose).at(-1);
}

export function equalVisibleChatState(previous: ChatViewState, next: ChatViewState): boolean {
  if (!equalActiveChatSession(previous.activeSession, next.activeSession)) return false;
  if (!Object.is(previous.allTranscript, next.allTranscript)) return false;
  if (!Object.is(previous.transcriptMutation, next.transcriptMutation)) return false;
  if (!Object.is(previous.models, next.models)) return false;
  if (!equalChildSelection(previous.selectedChild, next.selectedChild)) return false;
  if (previous.draftChat?.cwd !== next.draftChat?.cwd) return false;

  const appSessionId = next.activeSession?.appSessionId;
  if (!appSessionId) {
    return Object.is(latestPendingCompose(previous), latestPendingCompose(next));
  }
  if (
    !Object.is(previous.chatMetadata[appSessionId], next.chatMetadata[appSessionId]) ||
    !Object.is(previous.childAccess[appSessionId], next.childAccess[appSessionId]) ||
    !Object.is(previous.childSessions[appSessionId], next.childSessions[appSessionId]) ||
    previous.historyCursor[appSessionId] !== next.historyCursor[appSessionId] ||
    previous.historyLoadingOlder[appSessionId] !== next.historyLoadingOlder[appSessionId] ||
    !Object.is(previous.sessionRestore[appSessionId], next.sessionRestore[appSessionId]) ||
    previous.sessionSpecs[appSessionId] !== next.sessionSpecs[appSessionId] ||
    !Object.is(previous.specPlans[appSessionId], next.specPlans[appSessionId]) ||
    previous.transcriptRetainedCost[appSessionId] !== next.transcriptRetainedCost[appSessionId]
  ) {
    return false;
  }

  const childSessionId =
    next.selectedChild?.parentAppSessionId === appSessionId
      ? next.selectedChild.childSessionId
      : undefined;
  const previousChildHistory: Partial<ChatViewState['childHistory']> = previous.childHistory;
  const nextChildHistory: Partial<ChatViewState['childHistory']> = next.childHistory;
  return (
    !childSessionId ||
    Object.is(
      previousChildHistory[appSessionId]?.[childSessionId],
      nextChildHistory[appSessionId]?.[childSessionId],
    )
  );
}
