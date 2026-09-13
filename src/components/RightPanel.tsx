import { useMemo, useState } from 'react';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { useSessionLive } from '../hooks/useSessionLive';
import { useGitEnvironment } from '../hooks/useGitEnvironment';
import { useSessionWorkingDirectory } from '../hooks/useSessionWorkingDirectory';
import { usePullRequest } from '../hooks/usePullRequest';
import { useGithubSetup } from '../hooks/useGithubSetup';
import { resolveReasoningEffortDisplay } from '../lib/reasoningEffort';
import { motion, AnimatePresence } from 'framer-motion';
import { Hash, ChevronRight, FileText } from 'lucide-react';
import { ModelIcon, providerOf } from './ModelIcon';
import NotesSection from './NotesSection';
import { SubagentsSection } from './SubagentsPanel';
import { Row, SectionHeader, Divider } from './environment/primitives';
import { EnvironmentSection } from './environment/EnvironmentSection';
import type { DiffStatMode } from '../types/vcs';
import { diffModeToReviewScope } from '../lib/reviewScopes';
import {
  childSessionIsLive,
  spawnedChildSessions,
  visibleSessionTarget,
} from '../lib/childSessions';

export default function RightPanel() {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector((current) => {
    const activeSession = current.activeAppSessionId
      ? current.sessions[current.activeAppSessionId]
      : null;
    return {
      activeSession,
      activeTranscript: activeSession ? current.transcripts[activeSession.appSessionId] : undefined,
      agentConfig: current.agentConfig,
      childAccess: current.childAccess,
      childRuntime: current.childRuntime,
      childSessions: current.childSessions,
      models: current.models,
      selectedChild: current.selectedChild,
      selectedFeatureId: current.selectedFeatureId,
      sessionSpecs: current.sessionSpecs,
    };
  }, shallowEqual);
  const activeSession = state.activeSession;
  const cwd = useSessionWorkingDirectory(activeSession);

  const [diffMode, setDiffMode] = useState<DiffStatMode>('worktree');
  const git = useGitEnvironment(cwd, diffMode);
  const isGitHub = !!git.env?.isGitHub;
  const githubSetup = useGithubSetup(isGitHub, git.env?.repoRoot ?? cwd);
  const pr = usePullRequest(cwd, git.env?.branch ?? null, {
    enabled: isGitHub && githubSetup.isReady,
  });

  const visibleTarget = visibleSessionTarget(
    activeSession?.appSessionId,
    state.selectedChild,
    state.childSessions,
    state.childAccess,
  );
  const selectedAgent = visibleTarget.kind === 'child' ? visibleTarget.childSessionId : null;

  const sessionSpecsById: Partial<typeof state.sessionSpecs> = state.sessionSpecs;
  const activeSpec = activeSession ? sessionSpecsById[activeSession.appSessionId] : undefined;
  const specTitle = activeSpec?.title.trim() ?? '';

  // Authoritative "is the model generating right now" signal — respects the
  // backend `streaming` flag and terminal phases, so the spinner stops on reply.
  const working = useSessionLive(activeSession?.appSessionId ?? null);

  // Subagents spawned by this session, shown in the panel's Subagents section
  // (which owns their display order). Derived from the spawn events the same way
  // the feed's subagents card is, so both surfaces list a new agent at the same
  // moment instead of the panel waiting for the store to register it.
  const activeAppSessionId = activeSession?.appSessionId;
  const transcript = state.activeTranscript;
  const childSessions = useMemo(
    () =>
      activeAppSessionId
        ? spawnedChildSessions(
            transcript ?? [],
            Object.values(state.childSessions[activeAppSessionId] ?? {}),
          )
        : [],
    [activeAppSessionId, transcript, state.childSessions],
  );
  // Index access on these records is typed as always-present; Partial keeps the
  // lookup honest without changing runtime behavior.
  const childRuntimeByParent: Partial<typeof state.childRuntime> = state.childRuntime;
  const childSessionsRunning = childSessions.some((childSession) =>
    childSessionIsLive(
      childSession,
      childRuntimeByParent[childSession.parentAppSessionId]?.[childSession.childSessionId],
    ),
  );

  const modelInfo = activeSession?.modelId
    ? state.models.find((m) => m.id === activeSession.modelId)
    : undefined;
  const modelLabel = activeSession
    ? (modelInfo?.displayName ?? activeSession.modelId ?? 'default')
    : 'default';
  // The pill next to the model carries the session's reasoning effort, resolved
  // the same way as the composer badge: the session's own pinned effort, falling
  // back to the global default. Models without reasoning support show no pill.
  const reasoningEffort = activeSession
    ? resolveReasoningEffortDisplay(
        activeSession.reasoningEffort,
        state.agentConfig.primary.reasoning,
        modelInfo,
      )
    : undefined;

  // Folderless chats have no git environment to load — the panel skips the
  // Environment section so nothing spins forever. Subagents, spec, and notes
  // deliberately stay: they are session-scoped and work without a folder.
  const hasFolder = cwd !== '';

  // The model row lives inside Environment for folder-backed sessions and gets
  // its own section when the chat has no folder at all.
  const modelRow = activeSession ? (
    <Row
      icon={<ModelIcon provider={providerOf(modelInfo, activeSession.modelId)} size={16} />}
      label={<span className="font-medium">{modelLabel}</span>}
      title={modelLabel}
      trailing={
        reasoningEffort ? (
          <span className="shrink-0 rounded-md border border-droid-border/70 bg-droid-elevated px-1.5 py-0.5 text-[11px] font-medium capitalize leading-none text-droid-text-secondary">
            {reasoningEffort}
          </span>
        ) : undefined
      }
    />
  ) : null;

  return (
    <div
      data-testid="right-context-panel"
      className="shrink-0 w-[300px] pt-11 pb-3 pr-3 h-full flex items-start"
    >
      {/* The card hugs its content (capped at the available height). The rows
          that used to arrive late and grow it — PR detection, notes pad,
          subagent list — now share fixed slots or start collapsed, so the one
          remaining height change is the environment rows landing after mount. */}
      <div className="droid-card w-full max-h-full">
        {/* Header (no close button — the top toolbar button toggles this panel) */}
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-droid-border/70 pl-4 pr-3">
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-droid-text">
            Context
          </span>
          {working && <span className="shimmer-text text-[11px] font-medium">Working</span>}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
          {/* Environment — git-backed rows only exist for folder-backed chats */}
          {activeSession && hasFolder && (
            <div>
              <SectionHeader label="Environment" />
              <EnvironmentSection
                cwd={cwd}
                env={git.env}
                branches={git.branches}
                worktrees={git.worktrees}
                diffStat={git.diffStat}
                diffMode={diffMode}
                onDiffModeChange={setDiffMode}
                refresh={git.refresh}
                live={working || childSessionsRunning}
                githubAvailability={githubSetup.availability}
                githubAction={githubSetup.action}
                githubError={githubSetup.error}
                githubManualGuideOpened={githubSetup.manualGuideOpened}
                githubAuthCode={githubSetup.authCode}
                githubAuthPopoverOpen={githubSetup.isAuthPopoverOpen}
                githubReady={githubSetup.isReady}
                onGithubSetupAction={githubSetup.runPrimaryAction}
                onShowGithubAuthPrompt={githubSetup.showAuthPrompt}
                onCloseGithubAuthPrompt={githubSetup.closeAuthPrompt}
                onCancelGithubAuthentication={githubSetup.cancelAuthentication}
                pr={pr.pr}
                onOpenPr={() => {
                  dispatch({
                    type: 'OPEN_PULL_REQUESTS',
                    cwd,
                    number: pr.pr?.number ?? null,
                  });
                }}
                onOpenReview={() => {
                  dispatch({ type: 'SET_REVIEW_SCOPE', scope: diffModeToReviewScope(diffMode) });
                  dispatch({ type: 'SET_REVIEW_OPEN', open: true });
                }}
                onPrCreated={pr.refresh}
              />
              {modelRow}
            </div>
          )}

          {/* Folderless chats skip the git rows entirely — no perpetual
              "Loading environment…" for a folder that doesn't exist. */}
          {activeSession && !hasFolder && (
            <div>
              <SectionHeader label="Model" />
              {modelRow}
            </div>
          )}

          {/* Subagents — keyed by session so the popover's open state resets
              on a session switch instead of leaking into the next session. */}
          {activeSession && childSessions.length > 0 && (
            <div>
              <Divider />
              <SubagentsSection
                key={activeSession.appSessionId}
                childSessions={childSessions}
                models={state.models}
                selectedChildSessionId={selectedAgent}
                onSelect={(child) => {
                  dispatch({
                    type: 'SELECT_CHILD',
                    selection:
                      selectedAgent === child.childSessionId
                        ? null
                        : {
                            parentAppSessionId: child.parentAppSessionId,
                            childSessionId: child.childSessionId,
                          },
                  });
                }}
              />
            </div>
          )}

          {/* Spec — opens the full wiki reader for sessions that produced one */}
          {activeSession && activeSpec && (
            <div>
              <Divider />
              <SectionHeader label="Spec" />
              <Row
                icon={<FileText className="h-4 w-4" />}
                label={specTitle || 'Open spec'}
                title={specTitle || undefined}
                onClick={() => {
                  dispatch({ type: 'SPEC_OPEN_WIKI', appSessionId: activeSession.appSessionId });
                }}
                trailing={
                  <ChevronRight className="h-3.5 w-3.5 text-droid-text-muted/60 transition-colors group-hover:text-droid-text-secondary" />
                }
              />
            </div>
          )}

          {/* Notes — scratch reminders that hand their text to the composer.
              Keyed by session so the pad's draft and chipped tag reset on a
              session switch instead of leaking into the next session. */}
          {activeSession && (
            <div>
              <Divider />
              <NotesSection
                key={activeSession.appSessionId}
                appSessionId={activeSession.appSessionId}
              />
            </div>
          )}

          {/* Selected step detail */}
          <AnimatePresence>
            {activeSession &&
              state.selectedFeatureId &&
              (() => {
                const f = activeSession.features.find((x) => x.id === state.selectedFeatureId);
                if (!f) return null;
                return (
                  <motion.div
                    key={f.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mx-3 my-1.5 rounded-xl bg-droid-elevated/50 px-3 py-2.5 space-y-2">
                      <div className="text-[13px] text-droid-text leading-relaxed">
                        {f.description}
                      </div>
                      {f.skillName && (
                        <div className="flex items-center gap-2">
                          <Hash className="w-3.5 h-3.5 text-droid-text-muted" />
                          <span className="text-[11px] font-medium text-droid-text-secondary">
                            {f.skillName}
                          </span>
                        </div>
                      )}
                      {f.preconditions.length > 0 && (
                        <div className="space-y-1">
                          {f.preconditions.map((p, i) => (
                            <div
                              key={i}
                              className="text-[12px] text-droid-text-muted pl-3 border-l-2 border-droid-border"
                            >
                              {p}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })()}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
