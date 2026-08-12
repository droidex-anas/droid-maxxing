import { useEffect, useRef } from 'react';
import { shallowEqual, useStoreSelector } from './useStore';
import { addDiagnosticsBreadcrumb, setDiagnosticsContext } from '../lib/rendererDiagnostics';

/**
 * Keeps Sentry app-state context and the session-log ring buffer in sync with
 * operational state transitions. Only anonymized operational facts (mode,
 * autonomy level, session count, active view) are recorded — never prompts,
 * messages, file paths, or credentials.
 */
export function useDiagnosticsContext(): void {
  const { sessionCount, interactionMode, autonomy, sessionPurpose } = useStoreSelector((state) => {
    const activeSession = state.activeAppSessionId
      ? state.sessions[state.activeAppSessionId]
      : undefined;
    return {
      sessionCount: Object.keys(state.sessions).length,
      interactionMode: activeSession?.interactionMode,
      autonomy: activeSession?.autonomy,
      sessionPurpose: activeSession?.sessionPurpose,
    };
  }, shallowEqual);
  const prevCount = useRef(sessionCount);
  const prevMode = useRef(interactionMode);
  const prevAutonomy = useRef(autonomy);

  useEffect(() => {
    setDiagnosticsContext({
      interactionMode,
      autonomy,
      activeSessionCount: sessionCount,
      view: sessionPurpose ?? 'chat',
    });
  }, [interactionMode, autonomy, sessionPurpose, sessionCount]);

  useEffect(() => {
    if (prevCount.current !== sessionCount) {
      addDiagnosticsBreadcrumb(
        'session',
        sessionCount > prevCount.current ? 'session opened' : 'session closed',
      );
      prevCount.current = sessionCount;
    }
  }, [sessionCount]);

  useEffect(() => {
    if (prevMode.current !== interactionMode) {
      addDiagnosticsBreadcrumb('session', `mode changed to ${interactionMode ?? 'unknown'}`);
    }
    prevMode.current = interactionMode;
  }, [interactionMode]);

  useEffect(() => {
    if (prevAutonomy.current !== autonomy) {
      addDiagnosticsBreadcrumb('session', `autonomy changed to ${autonomy ?? 'unknown'}`);
    }
    prevAutonomy.current = autonomy;
  }, [autonomy]);

  useEffect(() => {
    addDiagnosticsBreadcrumb('app', 'app focused');
    const onBlur = () => {
      addDiagnosticsBreadcrumb('app', 'app blurred');
    };
    const onFocus = () => {
      addDiagnosticsBreadcrumb('app', 'app focused');
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}
