import { useCallback, useEffect, useState } from 'react';
import { useStoreDispatch } from '../../hooks/useStore';
import { addDesignReference, sendDesignPrompt } from '../../lib/commands';
import type { NativeBrowserDesignPrompt, NativeBrowserSelection } from '../../lib/nativeBrowser';
import { createLocalDesignTranscriptEvent, newQueueId } from '../../lib/promptQueue';
import type { DesignReference } from '../../types/bridge';
import { browserTranscriptReferencesFromDesignReferences } from './browserTranscriptReferences';

// Design-mode composer state (selection, instruction, pencil) together with the
// two ways a design prompt leaves the pane: queued behind a live turn, or sent
// straight through with a local transcript echo.
export function useBrowserDesignPrompt({
  browserKey,
  browserSessionId,
  browserUrl,
  designMode,
  requestedChatId,
  sessionLive,
}: {
  browserKey: string | undefined;
  browserSessionId: string | undefined;
  browserUrl: string | undefined;
  designMode: boolean;
  requestedChatId: string | undefined;
  sessionLive: boolean;
}) {
  const dispatch = useStoreDispatch();
  const [pencilMode, setPencilMode] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [references, setReferences] = useState<DesignReference[]>([]);

  useEffect(() => {
    setReferences([]);
    setInstruction('');
    setPencilMode(false);
  }, [browserSessionId, browserUrl, browserKey]);

  useEffect(() => {
    if (!designMode) setPencilMode(false);
  }, [designMode]);

  const selectedIds = references.map((ref) => ref.id).filter((id): id is string => Boolean(id));
  const canSend = Boolean(browserKey && selectedIds.length > 0 && instruction.trim());
  const disabledReason = !browserKey
    ? 'Select or create a Droid session'
    : selectedIds.length === 0
      ? 'Select a reference'
      : 'Enter a prompt';

  const emitDesignTranscript = useCallback(
    (text: string, refs: DesignReference[]) => {
      if (!requestedChatId) return;
      const browserRefs = browserTranscriptReferencesFromDesignReferences(refs);
      dispatch({
        type: 'SESSION_TRANSCRIPT',
        event: createLocalDesignTranscriptEvent(requestedChatId, text, browserRefs),
      });
    },
    [dispatch, requestedChatId],
  );

  // Stage a design prompt in the same client-side queue normal prompts use so
  // it shows up as a draggable item and is delivered (with its references) once
  // the current turn finishes, instead of hitting the backend mid-turn.
  const queueDesignPrompt = useCallback(
    (text: string, refs: DesignReference[], ids: string[]) => {
      if (!browserKey || !requestedChatId) return;
      dispatch({
        type: 'QUEUE_PROMPT',
        appSessionId: requestedChatId,
        prompt: {
          id: newQueueId(),
          text,
          skills: [],
          files: [],
          design: { browserKey, references: refs, referenceIds: ids },
        },
      });
    },
    [browserKey, dispatch, requestedChatId],
  );

  const sendPrompt = () => {
    if (!browserKey || !canSend) return;
    const text = instruction.trim();
    if (sessionLive) {
      queueDesignPrompt(text, references, selectedIds);
    } else {
      sendDesignPrompt(browserKey, text, selectedIds);
      emitDesignTranscript(text, references);
    }
    setReferences([]);
    setInstruction('');
    // Re-arm like Cursor: disarm after sending so the user clicks Design Mode
    // again to start a new selection instead of staying live.
    dispatch({ type: 'SET_DESIGN_MODE', appSessionId: browserKey, open: false });
  };

  const handleSelection = useCallback(
    (selection: NativeBrowserSelection) => {
      const reference = referenceFromNativeSelection(selection);
      setReferences([reference]);
      if (browserKey) addDesignReference(browserKey, reference);
    },
    [browserKey],
  );

  const handleNativePrompt = useCallback(
    (prompt: NativeBrowserDesignPrompt) => {
      if (!browserKey) return;
      const text = prompt.instruction.trim();
      if (!text) return;
      const reference = referenceFromNativeSelection(prompt.selection);
      const referenceId = reference.id;
      if (!referenceId) return;
      addDesignReference(browserKey, reference);
      if (sessionLive) {
        queueDesignPrompt(text, [reference], [referenceId]);
      } else {
        sendDesignPrompt(browserKey, text, [referenceId]);
        emitDesignTranscript(text, [reference]);
      }
      setReferences([]);
      dispatch({ type: 'SET_DESIGN_MODE', appSessionId: browserKey, open: false });
    },
    [browserKey, dispatch, emitDesignTranscript, sessionLive, queueDesignPrompt],
  );

  return {
    canSend,
    disabledReason,
    handleNativePrompt,
    handleSelection,
    instruction,
    pencilMode,
    references,
    sendPrompt,
    setInstruction,
    setPencilMode,
    setReferences,
  };
}

function referenceFromNativeSelection(selection: NativeBrowserSelection): DesignReference {
  return {
    id: selection.anchor.id,
    anchor: {
      ...selection.anchor,
      strokes: selection.anchor.strokes ?? selection.strokes,
    },
    detail: selection.detail,
    url: selection.url,
    title: selection.title,
    scroll: selection.scroll,
    screenshot: selection.screenshot,
  };
}
