import { useEffect, useRef } from 'react';
import { shallowEqual, useStoreDispatch, useStoreSelector } from './useStore';
import { isChatHidden } from '../lib/chatMetadata';
import { discoverChatPullRequests } from '../lib/chatPullRequests';

// App-owned discovery also runs when both the sidebar and Context are closed.
export function useChatPullRequests() {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector(
    (current) => ({ sessions: current.sessions, chatMetadata: current.chatMetadata }),
    shallowEqual,
  );
  const targetKey = JSON.stringify(
    Object.values(state.sessions)
      .filter((session) => !isChatHidden(state.chatMetadata[session.appSessionId]))
      .map((session) => [session.appSessionId, session.cwd])
      .sort(),
  );
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    let cancelled = false;
    let running = false;
    const getTargets = () =>
      Object.values(latest.current.sessions).filter(
        (session) => !isChatHidden(latest.current.chatMetadata[session.appSessionId]),
      );
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
        );
      } catch (error) {
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
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [dispatch, targetKey]);
}
