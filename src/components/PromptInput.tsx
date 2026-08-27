import { useState, useRef, useEffect, useMemo, useCallback, type SetStateAction } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  shallowEqual,
  useStoreApi,
  useStoreDispatch,
  useStoreSelector,
  type QueuedPrompt,
} from '../hooks/useStore';
import { useSessionLive } from '../hooks/useSessionLive';
import {
  sendToSession,
  sendToSessionNow,
  sendToChild,
  sendToChildNow,
  sendDesignPrompt,
  createSession,
  interruptVisibleSession,
  compactSession,
  updateSessionSettings,
  newClientRef,
  listSkills,
} from '../lib/commands';
import { browserTranscriptReferencesFromDesignReferences } from './browser/browserTranscriptReferences';
import {
  pickDirectory,
  pickFiles,
  listFiles,
  isDesktop,
  type FeedbackReportRequest,
} from '../lib/desktop';
import { useImageAttachments } from '../hooks/useImageAttachments';
import { useImageFileDrop } from '../hooks/useImageFileDrop';
import { ImageChip } from './composer/ImageChip';
import { AttachedFileChip } from './composer/AttachedFileChip';
import { ImageViewerModal } from './composer/ImageViewerModal';
import { ImageLightbox } from './media/ImageLightbox';
import { imageSrc, partitionImagePaths } from '../lib/localImage';
import { FeedbackModal } from './FeedbackModal';
import PlanSteps from './composer/PlanSteps';
import { QueuedPrompts } from './composer/QueuedPrompts';
import { markGitTurnStart } from '../lib/git';
import { isAppUpdateInstalling, useAppUpdate } from '../lib/appUpdate';
import { canRunAgents } from '../lib/runtimeHealth';
import {
  chatWorktreeName,
  prepareChatWorkingDirectory,
  type ChatWorkingDirectoryResult,
} from '../lib/chatWorkspace';
import {
  createLocalDesignTranscriptEvent,
  createPromptQueueDeliveryGuard,
  newQueueId,
} from '../lib/promptQueue';
import {
  composePrompt,
  isVisualizeCommand,
  parseSlashSkillInvocation,
  promptTextWithVisualize,
  responseFormatForPrompt,
  submitCommandFor,
  VISUALIZE_COMMAND,
} from '../lib/composePrompt';
import { hasCompleteAppBlock } from './appBlockRuntime';
import { resolveReasoningEffortDisplay } from '../lib/reasoningEffort';
import { compactionSettingsSnapshot } from '../lib/compactionSettings';
import { composerTextAfterSeed, resetComposerAfterSubmit } from '../lib/composerReset';
import { chipRemovedByBackspace } from '../lib/composerChips';
import { composerTrigger, menuItemsForTrigger } from './composer/menuItems';
import { useDraftSelections } from './composer/useDraftSelections';
import {
  childRuntimeSubmitTarget,
  childSessionLabel,
  commitChildPromptAfterBaseline,
  orderedChildSessions,
  visibleSessionCanCompact,
  visibleSessionTarget,
  type VisibleSessionTarget,
} from '../lib/childSessions';
import { ArrowUp, ChevronDown, LoaderCircle, SlidersHorizontal, Square } from 'lucide-react';
import { noteComposerInteractive } from '../lib/rendererPerf';
import AddMenu from './composer/AddMenu';
import { DraftSelections } from './composer/DraftSelections';
import ComposerMenu, { type MenuItem, type SlashCommand } from './ComposerMenu';
import ModelSelectorPopover from './ModelSelectorPopover';
import AutonomySelector from './AutonomySelector';
import { AUTONOMY_LABELS, missionStartAllowed } from '../lib/autonomy';
import {
  buildVisibleChildSettingsTarget,
  childSettingsReadinessLabel,
} from '../lib/exactChildSettings';
import AskUserInline from './AskUserInline';
import PermissionInline from './PermissionInline';
import PlanApprovalInline from './PlanApprovalInline';
import { ModelIcon, providerOf } from './ModelIcon';
import { StartInBar } from './environment/StartInBar';
import type { Autonomy, SkillInfo, TranscriptEvent } from '../types/bridge';
import { feedbackDraftFromCommand } from '../lib/feedbackReport';
import { useSessionWorkingDirectory } from '../hooks/useSessionWorkingDirectory';
import { useRuntimeHealth } from '../hooks/useRuntimeHealth';
import { toast } from '../lib/toast';

const ACCENT = 'var(--droid-accent)';
const accentMix = (pct: number) =>
  `color-mix(in srgb, var(--droid-accent) ${String(pct)}%, transparent)`;
type SubmitMode = 'queue' | 'now';
const oppositeSubmitMode = (mode: SubmitMode): SubmitMode => (mode === 'queue' ? 'now' : 'queue');

export function shouldShowTurnStarting(isLive: boolean): boolean {
  return !isLive;
}

export function shouldResumeQueuedPromptAfterUpdate(
  wasInstalling: boolean,
  isInstalling: boolean,
  isLive: boolean,
  hasQueuedPrompt: boolean,
  installResult: 'downloaded' | 'presented' | null,
): boolean {
  return (
    wasInstalling && !isInstalling && !isLive && hasQueuedPrompt && installResult === 'presented'
  );
}

export function hasAppContextForTranscript(
  events: TranscriptEvent[],
  childSessionId: string | null,
): boolean {
  return events.some((event) => {
    if (event.kind !== 'text' || event.author === 'user') return false;
    const belongsToTarget = childSessionId
      ? event.sourceSessionId === childSessionId
      : event.role === 'primary';
    return belongsToTarget && hasCompleteAppBlock(event.text ?? '');
  });
}

export function shouldStopTurnStarting({
  isLive,
  startingTargetKey,
  visibleTargetKey,
  pendingClientRef,
  pendingWasRegistered,
  pendingCompose,
  lastCreatedSessionRequest,
}: {
  isLive: boolean;
  startingTargetKey: string | null;
  visibleTargetKey: string;
  pendingClientRef: string | null;
  pendingWasRegistered: boolean;
  pendingCompose: Partial<Record<string, unknown>>;
  lastCreatedSessionRequest: { clientRef: string; appSessionId: string } | null;
}): boolean {
  const pendingSettled =
    pendingClientRef !== null &&
    pendingWasRegistered &&
    pendingCompose[pendingClientRef] === undefined;
  const createdSessionActivated =
    pendingSettled &&
    lastCreatedSessionRequest?.clientRef === pendingClientRef &&
    visibleTargetKey === `primary:${lastCreatedSessionRequest.appSessionId}`;
  return (
    isLive ||
    (startingTargetKey !== null &&
      startingTargetKey !== visibleTargetKey &&
      !createdSessionActivated) ||
    (pendingSettled && !createdSessionActivated)
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export default function PromptInput({
  rightInset = false,
  compact = false,
  onOverlayChange,
}: {
  rightInset?: boolean;
  compact?: boolean;
  onOverlayChange?: (open: boolean) => void;
}) {
  const dispatch = useStoreDispatch();
  const { downloading: appUpdateInstalling, installResult: appUpdateInstallResult } =
    useAppUpdate();
  const runtimeReady = useRuntimeHealth().canRunAgents;
  const runtimeActionsBlocked = appUpdateInstalling || !runtimeReady;
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      activeSession: current.activeAppSessionId
        ? current.sessions[current.activeAppSessionId]
        : null,
      agentConfig: current.agentConfig,
      childAccess: current.childAccess,
      childSessions: current.childSessions,
      compactionModel: current.compactionModel,
      compactionTokenLimit: current.compactionTokenLimit,
      compactionTokenLimitPerModel: current.compactionTokenLimitPerModel,
      composerSeed: current.composerSeed,
      defaultAutonomy: current.defaultAutonomy,
      draftAutonomy: current.draftAutonomy,
      draftChat: current.draftChat,
      imagePasteQuality: current.imagePasteQuality,
      lastCreatedSessionRequest: current.lastCreatedSessionRequest,
      liveEnterBehavior: current.liveEnterBehavior,
      missionControlMode: current.missionControlMode,
      models: current.models,
      pendingAutonomy: current.pendingAutonomy,
      pendingCompose: current.pendingCompose,
      promptQueue: current.promptQueue,
      selectedChild: current.selectedChild,
      skills: current.skills,
      skillsProviderSessionId: current.skillsProviderSessionId,
      specMode: current.specMode,
    }),
    shallowEqual,
  );
  const store = useStoreApi();
  const composerRevisionRef = useRef(0);
  const [input, setInputState] = useState('');
  const setInput = (value: SetStateAction<string>) => {
    composerRevisionRef.current += 1;
    setInputState(value);
  };
  const [caret, setCaret] = useState(0);
  // Shell-style prompt history: null while composing, otherwise an index into
  // promptHistory. The draft is stashed so ArrowDown past the newest restores it.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftBeforeHistory = useRef('');
  const [modelsOpen, setModelsOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [filesCwd, setFilesCwd] = useState<string | null>(null);
  const [attachedFiles, setAttachedFilesState] = useState<string[]>([]);
  const setAttachedFiles = (value: SetStateAction<string[]>) => {
    composerRevisionRef.current += 1;
    setAttachedFilesState(value);
  };
  const imageAttachments = useImageAttachments(state.imagePasteQuality);
  const fileDrop = useImageFileDrop(imageAttachments.addBlob);
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  // A path-only attachment has no staged copy to crop, so it opens the
  // read-only lightbox instead of the composer's image viewer.
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [feedbackReport, setFeedbackReport] = useState<FeedbackReportRequest | null>(null);
  const {
    activeSkills,
    setActiveSkills,
    visualizeSelected,
    setVisualizeSelected,
    items: draftSelections,
    hasSelection,
    indentPx: selectionsIndent,
    setIndentPx: setSelectionsIndent,
    clear: clearDraftSelections,
  } = useDraftSelections(
    useCallback(() => {
      composerRevisionRef.current += 1;
    }, []),
  );
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Skills and plugins live on the draft's first line; attachments keep their own
  // row above it. Backspace on an empty draft unwinds both.
  const hasAttachmentChips = attachedFiles.length > 0 || imageAttachments.images.length > 0;
  const hasChips = hasSelection || hasAttachmentChips;

  const removeLastChip = () => {
    const { images, files: documents } = partitionImagePaths(attachedFiles);
    const removal = chipRemovedByBackspace({
      visualizeSelected,
      pastedImageIds: imageAttachments.images.map((image) => image.id),
      imagePaths: images,
      skillFilePaths: activeSkills.map((skill) => skill.filePath),
      documentPaths: documents,
    });
    if (removal === null) return;
    switch (removal.chip) {
      case 'attachment':
        setAttachedFiles((prev) => prev.filter((path) => path !== removal.path));
        return;
      case 'skill':
        setActiveSkills((prev) => prev.filter((skill) => skill.filePath !== removal.filePath));
        return;
      case 'pastedImage':
        imageAttachments.remove(removal.id);
        return;
      case 'visualize':
        setVisualizeSelected(false);
        return;
    }
  };
  const [sendHover, setSendHover] = useState(false);
  const [turnStarting, setTurnStarting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!textareaRef.current) return;
    noteComposerInteractive();
  }, []);
  // The draft and the selections that share its first line. Autosize holds this
  // box still while it measures the draft.
  const draftBoxRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const turnStartingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnStartingTargetKeyRef = useRef<string | null>(null);
  const turnStartingClientRef = useRef<string | null>(null);
  const turnStartingPendingRegisteredRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const prevLive = useRef<{ appSessionId: string | null; live: boolean }>({
    appSessionId: null,
    live: false,
  });

  const activeSession = state.activeSession;
  const primaryIsLive = useSessionLive(state.activeAppSessionId);

  // The user's own prompts in this conversation, oldest to newest, for ArrowUp
  // recall (reuse a previous prompt). Consecutive duplicates are collapsed.
  const promptHistory = useStoreSelector((current) => {
    const events = activeSession ? (current.transcripts[activeSession.appSessionId] ?? []) : [];
    const out: string[] = [];
    for (const ev of events) {
      if (ev.author !== 'user' || ev.kind !== 'text') continue;
      const text = ev.text ?? '';
      if (!text.trim()) continue;
      if (out[out.length - 1] !== text) out.push(text);
    }
    return out;
  }, sameStrings);
  // For an existing chat session the mode is whatever the session actually is
  // (so a chat reopened in spec mode shows Spec); only fall back to the global
  // compose flag while drafting a brand-new chat.
  const isSpecMode =
    activeSession?.sessionPurpose !== 'mission-control'
      ? activeSession?.interactionMode === 'spec' || (!activeSession && state.specMode)
      : false;
  const selectedChild = state.selectedChild;
  const visibleTarget: VisibleSessionTarget = visibleSessionTarget(
    activeSession?.appSessionId,
    selectedChild,
    state.childSessions,
    state.childAccess,
  );
  const visibleTargetRef = useRef(visibleTarget);
  visibleTargetRef.current = visibleTarget;
  const targetChild = visibleTarget.kind === 'child' ? visibleTarget.child : undefined;
  const targetChildSessionId = targetChild?.childSessionId ?? null;
  const hasAppContext = useStoreSelector((current) => {
    if (!activeSession) return false;
    const events = current.transcripts[activeSession.appSessionId] ?? [];
    return hasAppContextForTranscript(events, targetChildSessionId);
  });
  const primaryWorkingDirectory = useSessionWorkingDirectory(activeSession);
  const childWorkingDirectory = useSessionWorkingDirectory(
    targetChild ? activeSession : null,
    targetChildSessionId ?? undefined,
  );
  const workingDirectory = targetChild ? childWorkingDirectory : primaryWorkingDirectory;
  const targetChildIndex =
    visibleTarget.kind === 'child' && activeSession
      ? orderedChildSessions(
          Object.values(state.childSessions[activeSession.appSessionId] ?? {}),
        ).findIndex((childSession) => childSession.childSessionId === visibleTarget.childSessionId)
      : -1;
  const childSettingsTarget = buildVisibleChildSettingsTarget(
    visibleTarget,
    targetChild ? childSessionLabel(targetChild, Math.max(0, targetChildIndex)) : 'Child session',
  );
  const childActionsEnabled = visibleTarget.kind !== 'child' || visibleTarget.canSend;
  const primaryActionsEnabled = visibleSessionCanCompact(visibleTarget);
  const compactionSettingsInput = {
    compactionTokenLimitPerModel: state.compactionTokenLimitPerModel,
    ...(state.compactionTokenLimit === undefined
      ? {}
      : { compactionTokenLimit: state.compactionTokenLimit }),
  };
  const isLive = visibleTarget.kind === 'child' ? visibleTarget.canInterrupt : primaryIsLive;
  const visibleTargetKey =
    visibleTarget.kind === 'child'
      ? `child:${visibleTarget.parentAppSessionId}:${visibleTarget.childSessionId}`
      : activeSession
        ? `primary:${activeSession.appSessionId}`
        : state.missionControlMode
          ? 'mission-draft'
          : 'chat-draft';
  const stopTurnStarting = useCallback(() => {
    if (turnStartingTimerRef.current) {
      clearTimeout(turnStartingTimerRef.current);
      turnStartingTimerRef.current = null;
    }
    turnStartingTargetKeyRef.current = null;
    turnStartingClientRef.current = null;
    turnStartingPendingRegisteredRef.current = false;
    setTurnStarting(false);
  }, []);
  const startTurnStarting = useCallback(
    (clientRef?: string) => {
      if (turnStartingTimerRef.current) clearTimeout(turnStartingTimerRef.current);
      turnStartingTimerRef.current = null;
      turnStartingTargetKeyRef.current = visibleTargetKey;
      turnStartingClientRef.current = clientRef ?? null;
      turnStartingPendingRegisteredRef.current = false;
      setTurnStarting(true);
    },
    [visibleTargetKey],
  );
  const armTurnStartingTimeout = useCallback(() => {
    if (turnStartingTargetKeyRef.current === null) return;
    if (turnStartingTimerRef.current) clearTimeout(turnStartingTimerRef.current);
    // This is only a final fallback for a command that never produces a live
    // or explicit failure event. Baseline preparation is intentionally outside
    // this window because large repositories can take longer than a minute.
    turnStartingTimerRef.current = setTimeout(() => {
      turnStartingTimerRef.current = null;
      turnStartingTargetKeyRef.current = null;
      turnStartingClientRef.current = null;
      turnStartingPendingRegisteredRef.current = false;
      setTurnStarting(false);
    }, 60_000);
  }, []);

  const cwd = activeSession?.cwd ?? state.draftChat?.cwd ?? null;
  const skillsProviderSessionId = activeSession?.providerSessionId ?? null;
  const pendingSkillsRequest = useRef<{
    providerSessionId: string | null;
    requestedAt: number;
  } | null>(null);

  // Toggle spec mode. When a live chat session exists, switch its interaction
  // mode for real (not just the compose flag used for brand-new chats).
  const toggleSpec = () => {
    if (activeSession && activeSession.sessionPurpose !== 'mission-control') {
      // Existing live chat: flip the session's real interaction mode and
      // optimistically update its interaction mode so the toggle reflects immediately.
      const turningOn = !isSpecMode;
      dispatch({
        type: 'SESSION_SET_INTERACTION_MODE',
        appSessionId: activeSession.appSessionId,
        interactionMode: turningOn ? 'spec' : 'auto',
      });
      updateSessionSettings({
        appSessionId: activeSession.appSessionId,
        interactionMode: turningOn ? 'spec' : 'auto',
      });
    } else {
      // Brand-new draft chat with no session yet: just flip the compose flag.
      dispatch({ type: 'TOGGLE_SPEC_MODE' });
    }
  };

  const slashCommands: SlashCommand[] = [
    {
      ...VISUALIZE_COMMAND,
      run: () => {
        setVisualizeSelected(true);
      },
    },
    {
      cmd: '/bug',
      desc: 'Send a private bug report',
      run: () => {
        setFeedbackReport({ category: 'bug', description: '' });
      },
    },
    {
      cmd: '/feedback',
      desc: 'Share private product feedback',
      run: () => {
        setFeedbackReport({ category: 'other', description: '' });
      },
    },
    {
      cmd: '/mission',
      desc: 'Enter Mission Control',
      run: () => {
        dispatch({ type: 'TOGGLE_MISSION_CONTROL' });
      },
    },
    {
      cmd: '/model',
      desc: 'Open model selector',
      run: () => {
        setModelsOpen(true);
      },
    },
    {
      cmd: '/compact',
      desc: 'Compact current session',
      run: () => {
        if (primaryActionsEnabled && activeSession) compactSession(activeSession.appSessionId);
      },
    },
    {
      cmd: '/spec',
      desc: 'Toggle spec mode',
      run: () => {
        toggleSpec();
      },
    },
    {
      cmd: '/settings',
      desc: 'Open settings',
      run: () => {
        dispatch({ type: 'TOGGLE_SETTINGS' });
      },
    },
  ];

  const trigger = useMemo(() => composerTrigger(input, caret), [input, caret]);
  const overlayOpen = [trigger, modelsOpen, addMenuOpen, feedbackReport, isLive && sendHover].some(
    Boolean,
  );

  useEffect(() => {
    if (!isLive) setSendHover(false);
  }, [isLive]);

  useEffect(() => {
    if (
      turnStarting &&
      shouldStopTurnStarting({
        isLive,
        startingTargetKey: turnStartingTargetKeyRef.current,
        visibleTargetKey,
        pendingClientRef: turnStartingClientRef.current,
        pendingWasRegistered: turnStartingPendingRegisteredRef.current,
        pendingCompose: state.pendingCompose,
        lastCreatedSessionRequest: state.lastCreatedSessionRequest,
      })
    ) {
      stopTurnStarting();
    }
  }, [
    isLive,
    state.lastCreatedSessionRequest,
    state.pendingCompose,
    stopTurnStarting,
    turnStarting,
    visibleTargetKey,
  ]);

  useEffect(
    () => () => {
      if (turnStartingTimerRef.current) clearTimeout(turnStartingTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    onOverlayChange?.(overlayOpen);
  }, [onOverlayChange, overlayOpen]);

  useEffect(
    () => () => {
      onOverlayChange?.(false);
    },
    [onOverlayChange],
  );

  const invocableSkills = useMemo(
    () =>
      state.skillsProviderSessionId === skillsProviderSessionId
        ? state.skills.filter((s) => s.userInvocable !== false && s.enabled !== false)
        : [],
    [skillsProviderSessionId, state.skills, state.skillsProviderSessionId],
  );

  useEffect(() => {
    if (trigger?.kind !== 'slash') {
      pendingSkillsRequest.current = null;
      return;
    }
    if (state.skillsProviderSessionId === skillsProviderSessionId) {
      pendingSkillsRequest.current = null;
      return;
    }
    const pending = pendingSkillsRequest.current;
    const now = Date.now();
    if (pending?.providerSessionId === skillsProviderSessionId && now - pending.requestedAt < 2_000)
      return;
    pendingSkillsRequest.current = {
      providerSessionId: skillsProviderSessionId,
      requestedAt: now,
    };
    listSkills(activeSession?.providerSessionId);
  }, [
    activeSession?.providerSessionId,
    skillsProviderSessionId,
    state.skillsProviderSessionId,
    trigger?.kind,
    trigger?.query,
    trigger?.start,
  ]);

  const menuItems = useMemo<MenuItem[]>(
    () =>
      trigger
        ? menuItemsForTrigger(trigger, {
            commands: slashCommands,
            skills: invocableSkills,
            files,
          })
        : [],
    [trigger, files, invocableSkills, slashCommands],
  );

  const menuOpen = !!trigger && menuItems.length > 0;

  // Lazy-load files when an @-trigger is active and cwd changed.
  useEffect(() => {
    if (trigger?.kind !== 'file' || !cwd) return;
    if (filesCwd === cwd) return;
    let cancelled = false;
    void listFiles(cwd).then((list) => {
      if (!cancelled) {
        setFiles(list);
        setFilesCwd(cwd);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [trigger, cwd, filesCwd]);

  useEffect(() => {
    setMenuIndex(0);
  }, [trigger?.kind, trigger?.query]);

  // Leave history-recall mode and drop any composer draft attachments when
  // switching conversations, so skills/files/images staged for one chat don't
  // linger on another chat's prompt bar. No prompt referenced the staged
  // images, so their temp files are deleted too. clearAndDiscardImages is
  // useCallback-stable, so this still fires only on a session switch.
  const clearAndDiscardImages = imageAttachments.clearAndDiscard;
  useEffect(() => {
    setHistoryIndex(null);
    clearDraftSelections();
    setAttachedFiles([]);
    // Both viewers show a dropped attachment, so they cannot outlive it.
    setViewerImageId(null);
    setViewerPath(null);
    clearAndDiscardImages();
  }, [activeSession?.appSessionId, clearAndDiscardImages, clearDraftSelections]);

  // Welcome-screen suggestion cards and saved notes seed the composer through
  // the store so those surfaces and this input stay decoupled. The pendingCaret
  // effect below focuses the field and moves the caret to the end of the text.
  const composerSeed = state.composerSeed;
  useEffect(() => {
    if (!composerSeed) return;
    setHistoryIndex(null);
    // Notes and suggestion cards append to an in-progress draft. A surface
    // that explicitly starts a fresh chat can replace stale mounted input.
    const text = composerTextAfterSeed(input, composerSeed.text, composerSeed.replace);
    setInput(text);
    pendingCaret.current = text.length;
    setVisualizeSelected(false);
    // Consume the seed so a later remount (e.g. toggling Mission Control, which
    // unmounts this input) does not re-apply stale text over the user's edits.
    dispatch({ type: 'CLEAR_COMPOSER_SEED' });
  }, [composerSeed, input, dispatch, setVisualizeSelected]);

  useEffect(() => {
    const draft = textareaRef.current;
    const box = draftBoxRef.current;
    if (!draft || !box) return;
    // A textarea reports its content height in scrollHeight only while the
    // content overflows the box, so measuring the draft means collapsing it to
    // `auto` first. Left alone, that collapse hands the composer's space back to
    // the transcript above for one layout pass: the browser clamps the
    // transcript's scroll position away from the bottom and never restores it,
    // so during a live turn the pin-to-bottom effect yanks it down again on the
    // next token, once per keystroke. Holding this box at the height it already
    // has keeps the collapse from reaching anything outside the composer, and
    // the box goes back to sizing itself before the browser paints.
    box.style.height = `${String(box.offsetHeight)}px`;
    draft.style.height = 'auto';
    draft.style.height = `${String(Math.min(draft.scrollHeight, 200))}px`;
    box.style.height = '';
    // The indent moves where the first line wraps, so it can change the height.
  }, [input, selectionsIndent]);

  // Restore caret after programmatic token replacement.
  useEffect(() => {
    if (pendingCaret.current != null && textareaRef.current) {
      const pos = pendingCaret.current;
      pendingCaret.current = null;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos);
      setCaret(pos);
    }
  }, [input]);

  const missionPreview = activeSession
    ? activeSession.sessionPurpose === 'mission-control'
    : state.missionControlMode;

  // Autonomy snapshot for a session this composer would create: the draft
  // override when the user picked one, otherwise the persisted app default.
  const draftAutonomy = state.draftAutonomy ?? state.defaultAutonomy;
  const [missionAutonomyGateOpen, setMissionAutonomyGateOpen] = useState(false);
  // The gate's premise is gone once the draft is at High (e.g. raised through
  // the selector while the gate is showing).
  useEffect(() => {
    if (missionAutonomyGateOpen && missionStartAllowed(draftAutonomy))
      setMissionAutonomyGateOpen(false);
  }, [missionAutonomyGateOpen, draftAutonomy]);

  // A single chat carries its own model/reasoning; only fall back to the global
  // default while composing a brand-new chat that has no session yet.
  const chatScoped = !missionPreview && !!activeSession;
  const primaryModelId = chatScoped ? activeSession.modelId : state.agentConfig.primary.modelId;
  const selectedModel = primaryModelId
    ? state.models.find((m) => m.id === primaryModelId)
    : undefined;
  const selectedModelLabel = primaryModelId
    ? (selectedModel?.displayName ?? primaryModelId)
    : 'Default model';
  const primaryReasoning = resolveReasoningEffortDisplay(
    chatScoped ? activeSession.reasoningEffort : undefined,
    state.agentConfig.primary.reasoning,
    selectedModel,
  );

  const replaceTrigger = (replacement: string) => {
    if (!trigger) return;
    const before = input.slice(0, trigger.start);
    const after = input.slice(trigger.end);
    const next = before + replacement + after;
    pendingCaret.current = before.length + replacement.length;
    setInput(next);
  };

  const addFile = (path: string) => {
    setAttachedFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
    replaceTrigger('');
  };

  // Plus button: native multi-file picker in the desktop app; in a plain
  // browser there is no dialog, so drop an @ trigger to open the file menu.
  const handleAttachFiles = async () => {
    if (!isDesktop()) {
      const next = input.length === 0 || input.endsWith(' ') ? `${input}@` : `${input} @`;
      setInput(next);
      pendingCaret.current = next.length;
      return;
    }
    const paths = await pickFiles();
    if (paths.length > 0) {
      setAttachedFiles((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
    }
  };

  const selectSkill = (skill: SkillInfo) => {
    setActiveSkills((prev) =>
      prev.some((s) => s.filePath === skill.filePath) ? prev : [...prev, skill],
    );
    replaceTrigger('');
  };

  const runCommand = (s: SlashCommand) => {
    if (s.replacement !== undefined) {
      replaceTrigger(s.replacement);
      return;
    }
    replaceTrigger('');
    s.run();
  };

  const runMenuItem = (item: MenuItem) => {
    if (item.type === 'command') runCommand(item.command);
    else if (item.type === 'skill') selectSkill(item.skill);
    else addFile(item.path);
  };

  const composeFrom = composePrompt;

  const prepareDraftCwd = async (
    dir: string,
    clientRef: string,
    title: string,
  ): Promise<ChatWorkingDirectoryResult> => {
    const draft = state.draftChat;
    const result = await prepareChatWorkingDirectory(dir, {
      executionMode: draft?.executionMode ?? 'local',
      base: draft?.branch,
      name: chatWorktreeName(title, clientRef),
    });
    if (result.ok) return result;

    toast.error(result.message ?? 'Could not create the chat worktree');
    return result;
  };

  // Re-entry guard: a send awaits markGitTurnStart before the input is cleared,
  // so without this a second Enter/click during that window would resend the
  // same payload (and create a duplicate session turn).
  const handleSubmit = async (mode: SubmitMode = 'queue', autonomyOverride?: Autonomy) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await runSubmit(mode, autonomyOverride);
    } finally {
      submittingRef.current = false;
    }
  };

  const runSubmit = async (mode: SubmitMode = 'queue', autonomyOverride?: Autonomy) => {
    const updateInterruptedSubmit = () => {
      if (isAppUpdateInstalling()) {
        toast.info('DROIDEX is installing an update. New turns will resume after restart.');
        return true;
      }
      if (!runtimeReady) {
        toast.info('The agent runtime is unavailable. History, files, and notes stay usable.');
        return true;
      }
      return false;
    };
    if (updateInterruptedSubmit()) return;
    const text = input.trim();
    // Snapshot the composer revision before the settle wait: text, files, and
    // skills are render-closure snapshots, so anything typed or staged while
    // images finish encoding is not part of this prompt — and must survive
    // the post-submit clear below.
    const composerRevision = composerRevisionRef.current;
    // Pasted/dropped images encode asynchronously; wait out any in-flight adds
    // so they make this prompt instead of surfacing on the next one via clear().
    const readyImages = await imageAttachments.whenSettled();
    if (updateInterruptedSubmit()) return;
    const allFiles = [...attachedFiles, ...readyImages.map((i) => i.path)];
    const hasPayload = text || visualizeSelected || activeSkills.length > 0 || allFiles.length > 0;
    if (!hasPayload) return;
    setHistoryIndex(null);

    const clearAfterSubmit = () => {
      resetComposerAfterSubmit({
        draftUntouched: composerRevisionRef.current === composerRevision,
        clearImages: () => {
          imageAttachments.clear();
          // Image chips always clear on submit, so a viewer open over one of them
          // would be showing an attachment the composer no longer holds.
          setViewerImageId(null);
          setViewerPath(null);
        },
        resetDraft: () => {
          setInput('');
          clearDraftSelections();
          setAttachedFiles([]);
        },
      });
    };

    const feedbackDraft = feedbackDraftFromCommand(text);
    if (feedbackDraft !== null) {
      setFeedbackReport(feedbackDraft);
      if (composerRevisionRef.current === composerRevision) setInput('');
      return;
    }

    const submitCommand = submitCommandFor(text, {
      visualizeSelected,
      skillCount: activeSkills.length,
      fileCount: allFiles.length,
    });
    if (submitCommand === 'mission') {
      dispatch({ type: 'TOGGLE_MISSION_CONTROL' });
      clearAfterSubmit();
      return;
    }
    if (submitCommand === 'compact') {
      if (!primaryActionsEnabled) return;
      if (activeSession) compactSession(activeSession.appSessionId);
      clearAfterSubmit();
      return;
    }

    if (!childActionsEnabled) return;

    const promptText = promptTextWithVisualize(text, visualizeSelected);
    const slashSkill =
      activeSkills.length === 0 && !isVisualizeCommand(promptText)
        ? parseSlashSkillInvocation(promptText, invocableSkills)
        : undefined;
    const displayText = slashSkill?.prompt ?? promptText;
    const responseFormat = responseFormatForPrompt(displayText, hasAppContext);
    const skillNames = slashSkill
      ? [slashSkill.skillName]
      : activeSkills.map((skill) => skill.name);
    const composed = composeFrom(displayText, skillNames, allFiles);
    const registerPending = (ref: string) => {
      if (turnStartingClientRef.current === ref) {
        turnStartingPendingRegisteredRef.current = true;
      }
      dispatch({
        type: 'SET_PENDING_COMPOSE',
        clientRef: ref,
        text: displayText,
        skills: skillNames,
        files: allFiles,
      });
    };

    // Mission Control preview with no active session: prompt is the objective.
    if (missionPreview && !activeSession) {
      const autonomy = autonomyOverride ?? draftAutonomy;
      // Missions run unattended, so starting one below High is blocked until
      // the user explicitly chooses High — the app never elevates silently.
      if (!missionStartAllowed(autonomy)) {
        setMissionAutonomyGateOpen(true);
        return;
      }
      const selectedDir = state.draftChat?.cwd ?? (await pickDirectory());
      if (!selectedDir) return;
      if (updateInterruptedSubmit()) return;
      const { primary, worker, validator } = state.agentConfig;
      const clientRef = newClientRef();
      const title = (displayText || skillNames[0] || 'Mission').slice(0, 48);
      startTurnStarting(clientRef);
      const preparation = await prepareDraftCwd(selectedDir, clientRef, title);
      if (!preparation.ok) {
        stopTurnStarting();
        return;
      }
      const dir = preparation.path;
      // Snapshot the tree before the agent's first turn so the Review "Last
      // turn" scope only attributes changes this session actually makes.
      await markGitTurnStart(dir, clientRef);
      if (updateInterruptedSubmit()) {
        stopTurnStarting();
        return;
      }
      registerPending(clientRef);
      clearAfterSubmit();
      try {
        createSession({
          clientRef,
          cwd: dir,
          title,
          goal: composed,
          sessionPurpose: 'mission-control',
          interactionMode: 'agi',
          autonomy,
          modelId: primary.modelId,
          reasoningEffort: primary.reasoning,
          compactionModel:
            state.compactionModel === 'current-model' ? undefined : state.compactionModel,
          // Only user-configured limits may override the daemon's model default.
          ...compactionSettingsSnapshot(compactionSettingsInput),
          workerModel: worker.modelId,
          workerReasoning: worker.reasoning,
          validatorModel: validator.modelId,
          validatorReasoning: validator.reasoning,
          ...(responseFormat ? { responseFormat } : {}),
        });
        armTurnStartingTimeout();
      } catch (error) {
        stopTurnStarting();
        console.error('[PromptInput] createSession failed:', error);
      }
      return;
    }

    // Draft/default chat: first message creates the session. No workspace is required.
    if (!activeSession) {
      const selectedDir = state.draftChat?.cwd ?? '';
      const { primary } = state.agentConfig;
      const clientRef = newClientRef();
      const title = (displayText || skillNames[0] || 'Chat').slice(0, 48);
      startTurnStarting(clientRef);
      const preparation = await prepareDraftCwd(selectedDir, clientRef, title);
      if (!preparation.ok) {
        stopTurnStarting();
        return;
      }
      const dir = preparation.path;
      if (dir) await markGitTurnStart(dir, clientRef);
      if (updateInterruptedSubmit()) {
        stopTurnStarting();
        return;
      }
      registerPending(clientRef);
      clearAfterSubmit();
      try {
        createSession({
          clientRef,
          cwd: dir,
          title,
          goal: composed,
          sessionPurpose: 'chat',
          interactionMode: isSpecMode ? 'spec' : 'auto',
          autonomy: draftAutonomy,
          modelId: primary.modelId,
          reasoningEffort: primary.reasoning,
          compactionModel:
            state.compactionModel === 'current-model' ? undefined : state.compactionModel,
          ...compactionSettingsSnapshot(compactionSettingsInput),
          ...(responseFormat ? { responseFormat } : {}),
        });
        armTurnStartingTimeout();
      } catch (error) {
        stopTurnStarting();
        console.error('[PromptInput] createSession failed:', error);
      }
      return;
    }

    // Model is working and the user chose to queue: stage the prompt locally.
    // It is held client-side and delivered automatically when the turn finishes.
    if (isLive && mode === 'queue' && !targetChildSessionId) {
      dispatch({
        type: 'QUEUE_PROMPT',
        appSessionId: activeSession.appSessionId,
        prompt: { id: newQueueId(), text: displayText, skills: skillNames, files: allFiles },
      });
      clearAfterSubmit();
      return;
    }

    const appendTranscript = () => {
      dispatch({
        type: 'SESSION_TRANSCRIPT',
        event: {
          id: `local-${String(Date.now())}`,
          appSessionId: activeSession.appSessionId,
          sourceSessionId: targetChildSessionId ?? 'user',
          role: targetChild?.role ?? 'primary',
          ts: Date.now(),
          kind: 'text',
          text: displayText,
          author: 'user',
          skills: skillNames,
          files: allFiles,
          steered: isLive && mode === 'now',
        },
      });
    };
    const sendCommand = () => {
      try {
        if (targetChildSessionId) {
          if (mode === 'now')
            sendToChildNow(
              activeSession.appSessionId,
              targetChildSessionId,
              composed,
              responseFormat,
            );
          else
            sendToChild(activeSession.appSessionId, targetChildSessionId, composed, responseFormat);
        } else if (mode === 'now')
          sendToSessionNow(activeSession.appSessionId, composed, responseFormat);
        else sendToSession(activeSession.appSessionId, composed, responseFormat);
        armTurnStartingTimeout();
      } catch (err) {
        stopTurnStarting();
        console.error('[PromptInput] sendToSession failed:', err);
      }
    };

    const childRuntimeTarget = childRuntimeSubmitTarget(visibleTarget);
    if (childRuntimeTarget && workingDirectory) {
      const showTurnStarting = shouldShowTurnStarting(isLive);
      if (showTurnStarting) startTurnStarting();
      const committed = await commitChildPromptAfterBaseline({
        capturedTarget: childRuntimeTarget,
        capturedComposerRevision: composerRevisionRef.current,
        waitForBaseline: () => markGitTurnStart(workingDirectory, activeSession.appSessionId),
        currentTarget: () => visibleTargetRef.current,
        currentComposerRevision: () => composerRevisionRef.current,
        canCommit: () => !isAppUpdateInstalling() && canRunAgents(),
        appendTranscript,
        resetComposer: clearAfterSubmit,
        sendCommand,
      });
      if (!committed && showTurnStarting) stopTurnStarting();
      return;
    }

    const showTurnStarting = shouldShowTurnStarting(isLive);
    if (showTurnStarting) startTurnStarting();

    // Capture the last-turn baseline before the agent can touch the tree;
    // a fire-and-forget call here races the first edit and corrupts the diff.
    if (!childRuntimeTarget && workingDirectory)
      await markGitTurnStart(workingDirectory, activeSession.appSessionId);
    if (updateInterruptedSubmit()) {
      if (showTurnStarting) stopTurnStarting();
      return;
    }
    appendTranscript();
    clearAfterSubmit();
    sendCommand();
  };

  const queue: QueuedPrompt[] = activeSession
    ? (state.promptQueue[activeSession.appSessionId] ?? [])
    : [];

  // Mirror the live queue so an async delivery can re-check membership after an
  // await, even though deliverPrompt closes over a stale render snapshot.
  const promptQueueRef = useRef(state.promptQueue);
  promptQueueRef.current = state.promptQueue;
  const promptQueueDelivery = useMemo(createPromptQueueDeliveryGuard, []);

  const deliverPrompt = async () => {
    if (!activeSession || isAppUpdateInstalling()) return;
    try {
      await promptQueueDelivery.run(async () => {
        // Capture the Last-turn git baseline before sending ANY prompt (design
        // included) so the Review tab diffs the turn from the right starting point.
        if (primaryWorkingDirectory)
          await markGitTurnStart(primaryWorkingDirectory, activeSession.appSessionId);
        if (isAppUpdateInstalling()) return;
        // The queue stays editable while that runs, so deliver whatever is now at
        // the head: this honors deletes and edits (both remove the item) as well as
        // reorders, and never sends a stale prompt out of the visible order.
        const head = (promptQueueRef.current[activeSession.appSessionId] ?? []).at(0);
        if (!head) return;

        if (head.design) {
          try {
            sendDesignPrompt(head.design.browserKey, head.text, head.design.referenceIds);
          } catch (err) {
            console.error('[PromptInput] queued design send failed:', err);
            return;
          }
          const browserRefs = browserTranscriptReferencesFromDesignReferences(
            head.design.references,
          );
          dispatch({
            type: 'SESSION_TRANSCRIPT',
            event: createLocalDesignTranscriptEvent(
              activeSession.appSessionId,
              head.text,
              browserRefs,
            ),
          });
          dispatch({
            type: 'REMOVE_QUEUED_PROMPT',
            appSessionId: activeSession.appSessionId,
            id: head.id,
          });
          return;
        }

        try {
          const primaryTranscript = store.getState().transcripts[activeSession.appSessionId] ?? [];
          sendToSession(
            activeSession.appSessionId,
            composeFrom(head.text, head.skills, head.files),
            responseFormatForPrompt(head.text, hasAppContextForTranscript(primaryTranscript, null)),
          );
        } catch (err) {
          // Keep the prompt staged and skip the transcript echo so a send failure
          // neither loses queued input nor leaves a duplicate user message behind.
          console.error('[PromptInput] queued send failed:', err);
          return;
        }
        dispatch({
          type: 'SESSION_TRANSCRIPT',
          event: {
            id: `local-${String(Date.now())}`,
            appSessionId: activeSession.appSessionId,
            sourceSessionId: 'user',
            role: 'primary',
            ts: Date.now(),
            kind: 'text',
            text: head.text,
            author: 'user',
            skills: head.skills,
            files: head.files,
          },
        });
        dispatch({
          type: 'REMOVE_QUEUED_PROMPT',
          appSessionId: activeSession.appSessionId,
          id: head.id,
        });
      });
    } catch (error) {
      console.error('[PromptInput] queued delivery preparation failed:', error);
    }
  };

  // When the current turn finishes, deliver the next staged prompt. Delivering
  // it restarts the turn, so the effect drains the queue one prompt at a time.
  useEffect(() => {
    const prev = prevLive.current;
    // Only deliver when the same session transitioned live -> idle. Switching
    // sessions mid-turn must not drain a different session's queue.
    if (prev.live && !primaryIsLive && prev.appSessionId === activeSession?.appSessionId) {
      const next = (state.promptQueue[activeSession.appSessionId] ?? []).at(0);
      if (next) void deliverPrompt();
    }
    prevLive.current = {
      appSessionId: activeSession?.appSessionId ?? null,
      live: primaryIsLive,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryIsLive, activeSession?.appSessionId]);

  const previousAppUpdateInstalling = useRef(appUpdateInstalling);
  useEffect(() => {
    const shouldResume = shouldResumeQueuedPromptAfterUpdate(
      previousAppUpdateInstalling.current,
      appUpdateInstalling,
      primaryIsLive,
      queue.length > 0,
      appUpdateInstallResult,
    );
    previousAppUpdateInstalling.current = appUpdateInstalling;
    if (shouldResume) void deliverPrompt();
    // deliverPrompt intentionally reads the latest queue through promptQueueRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUpdateInstalling]);

  const editQueuedInComposer = (p: QueuedPrompt) => {
    if (!activeSession) return;
    // The queued prompt carries its own files; drop any images pasted after it
    // was queued so they don't ride along on the edited prompt, and delete
    // their temp files — no prompt ever referenced them.
    imageAttachments.clearAndDiscard();
    setInput(p.text);
    // Its own attachments come back as chips: images among them render as
    // thumbnails again, so the restored draft looks like the one that was queued.
    setAttachedFiles(p.files);
    setActiveSkills(invocableSkills.filter((s) => p.skills.includes(s.name)));
    // A queued App request already carries /visualize in its text, so the chip
    // would add a second copy of the command.
    setVisualizeSelected(false);
    dispatch({ type: 'REMOVE_QUEUED_PROMPT', appSessionId: activeSession.appSessionId, id: p.id });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const reorderQueue = (from: number, to: number) => {
    if (activeSession)
      dispatch({ type: 'REORDER_QUEUE', appSessionId: activeSession.appSessionId, from, to });
  };

  const removeQueued = (id: string) => {
    if (activeSession)
      dispatch({ type: 'REMOVE_QUEUED_PROMPT', appSessionId: activeSession.appSessionId, id });
  };

  const syncCaret = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menuItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        runMenuItem(menuItems[Math.min(menuIndex, menuItems.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        replaceTrigger('');
        return;
      }
    }
    if (e.key === 'Backspace' && input === '' && hasChips) {
      e.preventDefault();
      removeLastChip();
      return;
    }
    // Shell-style history recall. ArrowUp starts only from the top of the field
    // (so it doesn't hijack caret movement in a multi-line draft); once in
    // history, arrows step through past prompts and ArrowDown exits at the draft.
    const plain = !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey;
    if (e.key === 'ArrowUp' && plain && promptHistory.length > 0) {
      const el = e.currentTarget;
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      if (historyIndex !== null || atStart) {
        e.preventDefault();
        if (historyIndex === null) draftBeforeHistory.current = input;
        const nextIndex =
          historyIndex === null ? promptHistory.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(nextIndex);
        const text = promptHistory[nextIndex];
        setInput(text);
        pendingCaret.current = text.length;
        return;
      }
    }
    if (e.key === 'ArrowDown' && plain && historyIndex !== null) {
      e.preventDefault();
      const text =
        historyIndex >= promptHistory.length - 1
          ? draftBeforeHistory.current
          : promptHistory[historyIndex + 1];
      setHistoryIndex(historyIndex >= promptHistory.length - 1 ? null : historyIndex + 1);
      setInput(text);
      pendingCaret.current = text.length;
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const enterMode: SubmitMode =
        isLive && state.liveEnterBehavior === 'interrupt' ? 'now' : 'queue';
      void handleSubmit(
        isLive && (e.metaKey || e.ctrlKey) ? oppositeSubmitMode(enterMode) : enterMode,
      );
    }
  };

  const boxBorder = isSpecMode
    ? 'border-droid-orange/40 focus-within:border-droid-orange/60'
    : 'border-droid-border focus-within:border-droid-border-hover';

  const viewerImage = imageAttachments.images.find((i) => i.id === viewerImageId) ?? null;
  // Files attached as paths (the @ menu, the picker, or a queued prompt brought
  // back for editing) show as thumbnails when they are displayable images, so a
  // pasted image looks the same before queueing and after reopening it.
  const { images: attachedImagePaths, files: attachedDocumentPaths } =
    partitionImagePaths(attachedFiles);
  const viewerSrc = viewerPath === null ? null : imageSrc(viewerPath);
  // The "Start in" repo/worktree/branch row only applies while drafting a brand
  // new chat; it renders as the top section of the composer card.
  const showStartIn = !activeSession && !missionPreview && !!cwd;
  const enterSteers = state.liveEnterBehavior === 'interrupt';
  const idleSendTooltip = childActionsEnabled
    ? 'Enter: send\nShift+Enter: newline'
    : 'This child transcript is read-only';
  const promptPlaceholder = missionPreview
    ? activeSession
      ? targetChildSessionId
        ? 'Steer the selected child session…'
        : 'Direct the orchestrator…'
      : 'Describe the mission objective…'
    : isSpecMode
      ? 'Describe what to build in spec mode...'
      : 'What would you like to work on?  (/ for skills, @ for files)';
  const hasContent =
    input.trim().length > 0 ||
    visualizeSelected ||
    activeSkills.length > 0 ||
    attachedFiles.length > 0 ||
    imageAttachments.images.length > 0;

  return (
    <div
      className={`w-full min-w-0 shrink-0 ${compact ? 'px-3 pb-3 pt-2' : 'px-6 pb-5 pt-2'}`}
      style={{ paddingRight: rightInset ? 312 : undefined, transition: 'padding-right 0.2s ease' }}
    >
      <div
        className={`relative mx-auto min-w-0 ${compact ? 'max-w-4xl' : 'max-w-3xl'}`}
        onDragOver={fileDrop.onDragOver}
        onDrop={fileDrop.onDrop}
      >
        <ComposerMenu
          open={menuOpen}
          triggerKind={trigger?.kind ?? null}
          filesLoading={!filesCwd}
          items={menuItems}
          activeIndex={menuIndex}
          activeSkills={activeSkills}
          attachedFiles={attachedFiles}
          onHoverItem={setMenuIndex}
          onRunItem={runMenuItem}
        />

        <PlanApprovalInline />
        <PermissionInline />
        <AskUserInline />

        {missionPreview ? (
          <div
            className="absolute -top-5 left-1 flex items-center gap-1.5 text-[10px] font-medium tracking-wide"
            style={{ color: ACCENT }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: ACCENT }} />
            Mission preview
          </div>
        ) : isSpecMode ? (
          <div className="absolute -top-5 left-1 text-[10px] font-medium text-droid-orange tracking-wide">
            SPEC MODE
          </div>
        ) : null}

        <QueuedPrompts
          queue={queue}
          onReorder={reorderQueue}
          onEdit={editQueuedInComposer}
          onRemove={removeQueued}
        />

        {showStartIn && (
          <div className="relative z-0 mx-[6%] -mb-3 min-w-0 rounded-t-2xl border border-droid-border bg-droid-surface px-4 pb-4 pt-1.5">
            <StartInBar />
          </div>
        )}

        <PlanSteps />

        <div
          className={`relative z-10 bg-droid-elevated border rounded-2xl transition-colors ${missionPreview ? '' : boxBorder}`}
          style={
            missionPreview
              ? {
                  borderColor: accentMix(40),
                  boxShadow: `0 0 0 1px ${accentMix(13)}, 0 10px 30px -12px ${accentMix(33)}`,
                }
              : undefined
          }
        >
          {hasAttachmentChips && (
            <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
              {imageAttachments.images.map((img) => (
                <ImageChip
                  key={img.id}
                  src={img.preview}
                  label={basename(img.path)}
                  onOpen={() => {
                    setViewerImageId(img.id);
                  }}
                  onRemove={() => {
                    imageAttachments.remove(img.id);
                  }}
                />
              ))}
              {attachedImagePaths.map((path) => {
                const src = imageSrc(path);
                // No discard on removal: the file was written for an
                // already-composed prompt, and the attachments store sweeps it.
                const remove = () => {
                  setAttachedFiles((prev) => prev.filter((x) => x !== path));
                };
                return src === null ? (
                  <AttachedFileChip key={path} path={path} onRemove={remove} />
                ) : (
                  <ImageChip
                    key={path}
                    src={src}
                    label={basename(path)}
                    onOpen={() => {
                      setViewerPath(path);
                    }}
                    onRemove={remove}
                  />
                );
              })}
              {attachedDocumentPaths.map((f) => (
                <AttachedFileChip
                  key={f}
                  path={f}
                  onRemove={() => {
                    setAttachedFiles((prev) => prev.filter((x) => x !== f));
                  }}
                />
              ))}
            </div>
          )}

          {missionAutonomyGateOpen && missionPreview && !activeSession && (
            <div className="mx-3 mt-3 flex items-center gap-3 rounded-xl border border-droid-border bg-droid-bg/60 px-3 py-2.5">
              <p className="flex-1 min-w-0 text-[11px] text-droid-text-secondary leading-snug">
                Missions run unattended, so they need{' '}
                <span className="text-droid-text font-medium">High autonomy</span> to start.
              </p>
              <button
                onClick={() => {
                  dispatch({ type: 'SET_DRAFT_AUTONOMY', autonomy: 'high' });
                  setMissionAutonomyGateOpen(false);
                  void handleSubmit('queue', 'high');
                }}
                className="shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-droid-bg transition-opacity hover:opacity-90"
                style={{ background: ACCENT }}
              >
                Set High and start
              </button>
              <button
                onClick={() => {
                  setMissionAutonomyGateOpen(false);
                }}
                className="shrink-0 px-2 py-1.5 rounded-lg text-[11px] text-droid-text-muted hover:text-droid-text transition-colors"
              >
                Not now
              </button>
            </div>
          )}

          <div className="relative" ref={draftBoxRef}>
            <DraftSelections items={draftSelections} onWidthChange={setSelectionsIndent} />
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                syncCaret(e.target);
                setHistoryIndex(null);
              }}
              onKeyUp={(e) => {
                syncCaret(e.currentTarget);
              }}
              onClick={(e) => {
                syncCaret(e.currentTarget);
              }}
              onSelect={(e) => {
                syncCaret(e.currentTarget);
              }}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                const items = Array.from(e.clipboardData.items).filter(
                  (it) => it.kind === 'file' && it.type.startsWith('image/'),
                );
                if (items.length === 0) return;
                e.preventDefault();
                for (const item of items) {
                  const blob = item.getAsFile();
                  if (blob) imageAttachments.addBlob(blob);
                }
              }}
              // A staged skill or plugin already says what this prompt will do,
              // and the hint would only crowd it off the line.
              placeholder={draftSelections.length > 0 ? '' : promptPlaceholder}
              rows={1}
              // A selection occupies the start of the first line, so the draft
              // starts after it and the placeholder stays out from under it.
              style={{
                textIndent: selectionsIndent === 0 ? undefined : `${String(selectionsIndent)}px`,
              }}
              className="w-full bg-transparent px-4 pt-3 pb-2 text-sm text-droid-text placeholder-droid-text-muted/50 resize-none focus:outline-none min-h-[44px] max-h-[200px]"
            />
          </div>

          {/* Toolbar — one seamless surface with the textarea, no divider line */}
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
            <AddMenu
              open={addMenuOpen}
              onOpenChange={setAddMenuOpen}
              visualizeSelected={visualizeSelected}
              // Both rows hand focus to the draft, which is where the prompt
              // continues once the menu has added to it.
              onAttachFiles={() => {
                textareaRef.current?.focus();
                void handleAttachFiles();
              }}
              onToggleVisualize={() => {
                setVisualizeSelected(!visualizeSelected);
                textareaRef.current?.focus();
              }}
            />

            <div className="relative shrink-0">
              <button
                onClick={() => {
                  setModelsOpen((v) => !v);
                }}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition-colors max-w-[200px] ${
                  modelsOpen
                    ? 'bg-droid-bg/60 text-droid-text'
                    : 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-bg/40'
                }`}
                title={
                  childSettingsTarget
                    ? `${childSettingsTarget.label} · ${childSettingsReadinessLabel(childSettingsTarget.readiness)}`
                    : missionPreview
                      ? 'Configure orchestrator / worker / validator models'
                      : 'Select chat model'
                }
              >
                {childSettingsTarget ? (
                  <>
                    <ModelIcon
                      provider={providerOf(
                        state.models.find((model) => model.id === childSettingsTarget.modelId),
                        childSettingsTarget.modelId,
                      )}
                      size={14}
                    />
                    <span className="truncate">{childSettingsTarget.label}</span>
                  </>
                ) : missionPreview ? (
                  <>
                    <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
                    <span>Models</span>
                  </>
                ) : (
                  <>
                    <ModelIcon provider={providerOf(selectedModel, primaryModelId)} size={14} />
                    <span className="truncate">{selectedModelLabel}</span>
                    {primaryReasoning && (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded-md text-[9px] font-medium capitalize leading-none"
                        style={{
                          color: 'var(--droid-accent)',
                          backgroundColor:
                            'color-mix(in srgb, var(--droid-accent) 13%, transparent)',
                        }}
                        title={`Reasoning: ${primaryReasoning}`}
                      >
                        {primaryReasoning}
                      </span>
                    )}
                  </>
                )}
                <ChevronDown
                  className={`w-3 h-3 shrink-0 text-droid-text-muted/40 transition-transform ${modelsOpen ? 'rotate-180' : ''}`}
                />
              </button>

              <AnimatePresence>
                {modelsOpen && (
                  <ModelSelectorPopover
                    onClose={() => {
                      setModelsOpen(false);
                    }}
                    singleAgent={!missionPreview}
                    childTarget={childSettingsTarget}
                  />
                )}
              </AnimatePresence>
            </div>

            <button
              onClick={toggleSpec}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition-colors shrink-0 ${
                isSpecMode
                  ? 'text-droid-accent bg-droid-accent/10 hover:bg-droid-accent/15'
                  : 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-bg/40'
              }`}
            >
              <span>{isSpecMode ? 'Spec' : 'Chat'}</span>
            </button>

            <div className="flex-1 min-w-0" />

            {queue.length > 0 ? (
              <span className="rounded-md border border-droid-border bg-droid-elevated/70 px-1.5 py-0.5 tabular-nums text-[10px] text-droid-text-secondary">
                {queue.length} queued
              </span>
            ) : null}

            {/* Autonomy: read-only for a targeted child, live control for an
                open session, draft override before a session exists. */}
            {targetChild ? (
              <span
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] text-droid-text-muted shrink-0"
                title={
                  targetChild.autonomy
                    ? `Child session autonomy: ${AUTONOMY_LABELS[targetChild.autonomy]}`
                    : 'Child autonomy is managed by the provider until the session is opened'
                }
              >
                <span>
                  {targetChild.autonomy
                    ? AUTONOMY_LABELS[targetChild.autonomy]
                    : 'Provider managed'}
                </span>
              </span>
            ) : activeSession ? (
              <AutonomySelector
                scope="session"
                value={activeSession.autonomy}
                pending={activeSession.appSessionId in state.pendingAutonomy}
                onSelect={(level) => {
                  dispatch({
                    type: 'AUTONOMY_UPDATE_REQUESTED',
                    appSessionId: activeSession.appSessionId,
                    autonomy: level,
                  });
                  updateSessionSettings({
                    appSessionId: activeSession.appSessionId,
                    autonomy: level,
                  });
                }}
              />
            ) : (
              <AutonomySelector
                scope="draft"
                value={draftAutonomy}
                onSelect={(level) => {
                  dispatch({ type: 'SET_DRAFT_AUTONOMY', autonomy: level });
                }}
              />
            )}

            {turnStarting ? (
              <button
                type="button"
                disabled
                title="Starting turn"
                className="p-2 rounded-full text-droid-bg shrink-0 opacity-90"
                style={{ background: ACCENT }}
              >
                <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
              </button>
            ) : isLive && !hasContent ? (
              <button
                onClick={() => {
                  if (activeSession)
                    interruptVisibleSession(activeSession.appSessionId, targetChildSessionId);
                }}
                title="Working — click to stop"
                className="p-2 rounded-full text-droid-bg shrink-0 transition-opacity hover:opacity-90"
                style={{ background: ACCENT }}
              >
                <Square className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} />
              </button>
            ) : isLive ? (
              <div
                className="relative shrink-0"
                onMouseEnter={() => {
                  setSendHover(true);
                }}
                onMouseLeave={() => {
                  setSendHover(false);
                }}
              >
                <AnimatePresence>
                  {sendHover && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 4 }}
                      transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                      className="absolute bottom-full right-0 mb-2 z-50 flex flex-col gap-0.5 rounded-xl border border-droid-border bg-droid-elevated p-1.5 shadow-2xl shadow-black/40"
                    >
                      {[
                        { label: enterSteers ? 'Steer' : 'Queue', keys: ['⏎'] },
                        { label: enterSteers ? 'Queue' : 'Steer', keys: ['⌘', '⏎'] },
                      ].map((row) => (
                        <div
                          key={row.label}
                          className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 text-[12px] text-droid-text"
                        >
                          <span>{row.label}</span>
                          <span className="flex items-center gap-0.5 rounded-md bg-droid-bg/70 px-1.5 py-0.5 text-[11px] text-droid-text-secondary">
                            {row.keys.map((k) => (
                              <kbd key={k} className="font-sans leading-none">
                                {k}
                              </kbd>
                            ))}
                          </span>
                        </div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
                <button
                  onClick={() => void handleSubmit(enterSteers ? 'now' : 'queue')}
                  disabled={runtimeActionsBlocked}
                  title={
                    appUpdateInstalling
                      ? 'Installing DROIDEX update'
                      : runtimeReady
                        ? undefined
                        : 'Agent runtime is unavailable'
                  }
                  className="p-2 rounded-full text-droid-bg transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background: ACCENT }}
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => void handleSubmit()}
                disabled={!hasContent || !childActionsEnabled || runtimeActionsBlocked}
                title={
                  appUpdateInstalling
                    ? 'Installing DROIDEX update'
                    : runtimeReady
                      ? idleSendTooltip
                      : 'Agent runtime is unavailable'
                }
                className="p-2 rounded-full text-droid-bg transition-all enabled:hover:opacity-90 disabled:opacity-25 disabled:cursor-not-allowed shrink-0"
                style={{ background: ACCENT }}
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {viewerImage && (
        <ImageViewerModal
          image={viewerImage}
          onClose={() => {
            setViewerImageId(null);
          }}
          onCrop={imageAttachments.applyCrop}
        />
      )}
      {viewerPath !== null && viewerSrc !== null && (
        <ImageLightbox
          src={viewerSrc}
          label={viewerPath}
          onClose={() => {
            setViewerPath(null);
          }}
        />
      )}
      {feedbackReport && (
        <FeedbackModal
          initialReport={feedbackReport}
          onClose={() => {
            setFeedbackReport(null);
          }}
        />
      )}
    </div>
  );
}
