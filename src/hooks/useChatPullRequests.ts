import { useEffect, useState } from 'react';
import { useStoreApi, useStoreDispatch, useStoreSelector, type AppState } from './useStore';
import { isChatHidden } from '../lib/chatMetadata';
import { discoverChatPullRequests } from '../lib/chatPullRequests';

// Stable selector: token updates keep the same key and do not re-render the app.
// Cache the input references to avoid rescanning on unrelated store changes.
export function createTargetKeySelector() {
  let sessions: AppState['sessions'] | undefined;
  let metadata: AppState['chatMetadata'] | undefined;
  let active: string | null = null;
  let key = '';
  return (state: AppState) => {
    if (
      sessions === state.sessions &&
      metadata === state.chatMetadata &&
      active === state.activeAppSessionId
    )
      return key;
    sessions = state.sessions;
    metadata = state.chatMetadata;
    active = state.activeAppSessionId;
    key = JSON.stringify([
      active,
      Object.values(sessions)
        .filter((session) => !isChatHidden(state.chatMetadata[session.appSessionId]))
        .map((session) => [session.appSessionId, session.cwd])
        .sort(),
    ]);
    return key;
  };
}

// App-owned discovery also runs when both the sidebar and Context are closed.
export function useChatPullRequests() {
  const dispatch = useStoreDispatch();
  const store = useStoreApi();
  const [selectTargetKey] = useState(createTargetKeySelector);
  const targetKey = useStoreSelector(selectTargetKey);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let running = false;
    const getTargets = () => {
      const state = store.getState();
      return Object.values(state.sessions).filter(
        (session) => !isChatHidden(state.chatMetadata[session.appSessionId]),
      );
    };
    const refresh = async () => {
      if (cancelled || running || document.hidden) return;
      running = true;
      try {
        await discoverChatPullRequests(
          getTargets,
          (cwd, appSessionIds, pr) => {
            dispatch({
              type: 'LINK_CHATS_PR',
              appSessionIds,
              cwd,
              pr,
            });
          },
          () => cancelled || document.hidden,
          undefined,
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Automatic chat PR discovery failed; retrying on the next refresh.', error);
      } finally {
        running = false;
      }
    };
    const tick = () => {
      void refresh();
    };
    tick();
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [dispatch, store, targetKey]);
}
