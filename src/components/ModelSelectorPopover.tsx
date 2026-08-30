import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Search } from 'lucide-react';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import type { AgentKind } from '../hooks/persistedUiPreferences';
import type {
  ProviderInstanceId,
  ReasoningEffort,
  ModelInfo,
  SessionConfiguration,
} from '../types/bridge';
import {
  updateAgentSettings,
  updateChildSettings,
  updateSessionSettings,
  listModels,
  refreshProviders,
} from '../lib/commands';
import {
  sessionModelId,
  sessionReasoningEffort,
  withProviderSelection,
} from '../lib/sessionConfiguration';
import {
  childSettingsReadinessLabel,
  planChildModelUpdate,
  type ExactChildSettingsTarget,
} from '../lib/exactChildSettings';
import ModelCatalogList from './ModelCatalogList';
import ModelCategoryFilter, { categoryOf, type ModelCategory } from './ModelCategoryFilter';
import HarnessStrip from '../features/providers/HarnessStrip';
import {
  activeHarnessId,
  defaultModelId,
  modelsForHarness,
  snapshotForHarness,
} from '../features/providers/providerCatalog';
import { composerCapabilities } from '../features/providers/providerCapabilities';
import {
  loadProviderDraft,
  persistDraftHarness,
  persistHarnessSelection,
} from '../features/providers/providerDraft';

export type { ExactChildSettingsTarget } from '../lib/exactChildSettings';

const ACCENT = 'var(--droid-accent)';
const accentMix = (pct: number) =>
  `color-mix(in srgb, var(--droid-accent) ${String(pct)}%, transparent)`;

const AGENTS: { kind: AgentKind; label: string; hint: string }[] = [
  { kind: 'primary', label: 'Primary', hint: 'Runs the session' },
  { kind: 'worker', label: 'Worker', hint: 'Executes each feature' },
  { kind: 'validator', label: 'Validator', hint: 'Verifies the work' },
];

const BASE_REASONING: ReasoningEffort[] = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'dynamic',
];

export default function ModelSelectorPopover({
  onClose,
  singleAgent = false,
  childTarget,
}: {
  onClose: () => void;
  singleAgent?: boolean;
  childTarget?: ExactChildSettingsTarget;
}) {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector((current) => {
    const activeSession = current.activeAppSessionId
      ? current.sessions[current.activeAppSessionId]
      : undefined;
    return {
      activeAppSessionId: current.activeAppSessionId,
      activeSessionAppSessionId: activeSession?.appSessionId,
      activeSessionModelId: activeSession ? sessionModelId(activeSession) : undefined,
      activeSessionReasoning: activeSession ? sessionReasoningEffort(activeSession) : undefined,
      activeSessionConfiguration: activeSession?.configuration,
      agentConfig: current.agentConfig,
      models: current.models,
      providerSnapshots: current.providerSnapshots,
      draftProviderInstanceId: current.draftProviderInstanceId,
    };
  }, shallowEqual);
  const [agent, setAgent] = useState<AgentKind>('primary');
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<ModelCategory | 'all'>('all');
  const ref = useRef<HTMLDivElement>(null);
  const childMode = childTarget !== undefined;
  const harnessId = activeHarnessId({
    activeSession: state.activeSessionConfiguration
      ? { configuration: state.activeSessionConfiguration }
      : null,
    draftProviderInstanceId: state.draftProviderInstanceId,
  });
  const snapshot = snapshotForHarness(state.providerSnapshots, harnessId);
  const capabilities = composerCapabilities(state.providerSnapshots, harnessId);
  const locked = Boolean(singleAgent && state.activeSessionAppSessionId);
  const showMissionTabs =
    !singleAgent && !childTarget && harnessId === 'droid' && capabilities.missionControl;

  const selectedAgent = childTarget?.role ?? agent;
  const active = AGENTS.find((a) => a.kind === selectedAgent) ?? {
    kind: selectedAgent,
    label: 'Agent',
    hint: '',
  };
  const cfg = state.agentConfig[selectedAgent];

  const scopedAppSessionId = singleAgent ? state.activeSessionAppSessionId : undefined;
  const source = modelsForHarness({
    harnessId,
    droidModels: state.models,
    snapshots: state.providerSnapshots,
  });
  const effModelId =
    childTarget?.modelId ?? (scopedAppSessionId ? state.activeSessionModelId : cfg.modelId);
  const effReasoning =
    childTarget?.reasoningEffort ??
    (scopedAppSessionId ? state.activeSessionReasoning : undefined) ??
    cfg.reasoning;
  const effReasoningRef = useRef(effReasoning);
  effReasoningRef.current = effReasoning;
  const childReady = childTarget?.readiness === 'ready';
  const hasRealModels = source.length > 0;

  useEffect(() => {
    refreshProviders();
    listModels();
  }, []);

  const models = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((m) => {
      if (harnessId === 'droid' && cat !== 'all' && categoryOf(m) !== cat) return false;
      if (!q) return true;
      return m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    });
  }, [source, query, cat, harnessId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const selectedLabel = (() => {
    if (!effModelId) return 'Default';
    const m = source.find((x) => x.id === effModelId);
    return m?.displayName ?? effModelId;
  })();
  const selectedConfigModel = effModelId ? source.find((x) => x.id === effModelId) : undefined;
  const selectedSupportedReasoning = selectedConfigModel?.supportedReasoningEfforts;
  const reasoningOptions = reasoningChoices(
    selectedConfigModel,
    selectedSupportedReasoning,
    harnessId,
    effReasoning,
  );

  const updateReasoning = useCallback(
    (reasoning: ReasoningEffort) => {
      if (childTarget) return;
      if (effModelId)
        persistHarnessSelection(harnessId, { modelId: effModelId, reasoningEffort: reasoning });
      if (scopedAppSessionId)
        dispatch({
          type: 'SESSION_SET_REASONING',
          appSessionId: scopedAppSessionId,
          reasoning,
        });
      else dispatch({ type: 'SET_AGENT_REASONING', agent, reasoning });
      persistLiveOrDraft({
        harnessId,
        scopedAppSessionId,
        activeAppSessionId: state.activeAppSessionId,
        configuration: state.activeSessionConfiguration,
        agent,
        patch: { reasoning },
      });
    },
    [
      agent,
      childTarget,
      dispatch,
      effModelId,
      harnessId,
      scopedAppSessionId,
      state.activeAppSessionId,
      state.activeSessionConfiguration,
    ],
  );

  const updateModel = useCallback(
    (modelId?: string) => {
      const currentReasoning = effReasoningRef.current;
      if (childTarget) {
        const update = planChildModelUpdate(childTarget, modelId, currentReasoning, source);
        if (update) updateChildSettings(update);
        return;
      }
      if (modelId)
        persistHarnessSelection(harnessId, { modelId, reasoningEffort: currentReasoning });
      if (scopedAppSessionId)
        dispatch({
          type: 'SESSION_SET_MODEL',
          appSessionId: scopedAppSessionId,
          modelId,
        });
      else dispatch({ type: 'SET_AGENT_MODEL', agent, modelId });
      persistLiveOrDraft({
        harnessId,
        scopedAppSessionId,
        activeAppSessionId: state.activeAppSessionId,
        configuration: state.activeSessionConfiguration,
        agent,
        patch: { modelId },
      });

      const next = modelId ? source.find((x) => x.id === modelId) : undefined;
      const supported = next?.supportedReasoningEfforts;
      if (supported?.length && !supported.includes(currentReasoning)) {
        updateReasoning(next?.defaultReasoningEffort ?? supported[supported.length - 1]);
      } else if (
        !supported?.length &&
        next?.defaultReasoningEffort &&
        currentReasoning !== next.defaultReasoningEffort
      ) {
        updateReasoning(next.defaultReasoningEffort);
      }
    },
    [
      agent,
      childTarget,
      dispatch,
      harnessId,
      scopedAppSessionId,
      source,
      state.activeAppSessionId,
      state.activeSessionConfiguration,
      updateReasoning,
    ],
  );

  useEffect(() => {
    if (childMode) return;
    const supported = selectedSupportedReasoning;
    if (supported?.length && !supported.includes(effReasoning)) {
      updateReasoning(
        selectedConfigModel?.defaultReasoningEffort ?? supported[supported.length - 1],
      );
    }
  }, [
    childMode,
    effReasoning,
    selectedConfigModel?.defaultReasoningEffort,
    selectedConfigModel?.id,
    selectedSupportedReasoning,
    updateReasoning,
  ]);

  const selectHarness = (next: ProviderInstanceId) => {
    if (locked || childTarget) return;
    if (effModelId) {
      persistHarnessSelection(harnessId, {
        modelId: effModelId,
        reasoningEffort: effReasoning,
      });
    }
    persistDraftHarness(next);
    const nextSource = modelsForHarness({
      harnessId: next,
      droidModels: state.models,
      snapshots: state.providerSnapshots,
    });
    const remembered = loadProviderDraft().selections[next]?.modelId;
    const restored =
      remembered && nextSource.some((model) => model.id === remembered)
        ? remembered
        : defaultModelId(nextSource);
    dispatch({
      type: 'SET_DRAFT_PROVIDER',
      providerInstanceId: next,
      modelId: restored,
      reasoning: nextSource.find((model) => model.id === restored)?.defaultReasoningEffort,
    });
  };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      className="absolute bottom-full left-0 mb-3 w-[380px] z-50"
    >
      <div className="rounded-2xl border border-droid-border bg-droid-elevated shadow-2xl shadow-black/50 overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="text-[11px] font-medium text-droid-text-secondary tracking-wide">
            {childTarget ? childTarget.label : singleAgent ? 'Model' : 'Models'}
          </span>
          <span className="text-[10px] text-droid-text-muted">
            {childTarget
              ? childTarget.readiness === 'ready'
                ? `${active.label} model`
                : childSettingsReadinessLabel(childTarget.readiness)
              : singleAgent
                ? 'Used for this chat'
                : active.hint}
          </span>
        </div>

        {singleAgent && !childTarget && (
          <HarnessStrip
            selected={harnessId}
            locked={locked}
            snapshots={state.providerSnapshots}
            onSelect={selectHarness}
          />
        )}

        {showMissionTabs && (
          <div className="px-3">
            <div className="flex gap-1 p-0.5 rounded-xl bg-droid-bg/60 border border-droid-border">
              {AGENTS.map((a) => {
                const on = a.kind === agent;
                return (
                  <button
                    key={a.kind}
                    onClick={() => {
                      setAgent(a.kind);
                    }}
                    className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors truncate ${
                      on
                        ? 'bg-droid-surface text-droid-text'
                        : 'text-droid-text-muted hover:text-droid-text-secondary'
                    }`}
                    style={on ? { boxShadow: `inset 0 0 0 1px ${accentMix(33)}` } : undefined}
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {reasoningOptions.length > 0 && (
          <div className="px-4 pt-3.5 pb-1">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-droid-text-muted uppercase tracking-wider">
                Reasoning
              </span>
              <span className="text-[10px] font-medium capitalize" style={{ color: ACCENT }}>
                {effReasoning}
              </span>
            </div>
            <div className="relative flex p-0.5 rounded-lg bg-droid-bg/60 border border-droid-border">
              {reasoningOptions.map((r) => {
                const on = effReasoning === r;
                return (
                  <button
                    key={r}
                    onClick={() => {
                      updateReasoning(r);
                    }}
                    disabled={Boolean(childTarget)}
                    title={childTarget ? 'Change the child model to adjust reasoning.' : undefined}
                    className={`relative flex-1 py-1.5 rounded-md text-[10px] capitalize transition-colors ${
                      on
                        ? 'text-droid-text'
                        : childTarget
                          ? 'text-droid-text-muted/50 cursor-not-allowed'
                          : 'text-droid-text-muted hover:text-droid-text-secondary'
                    }`}
                  >
                    {on && (
                      <motion.span
                        layoutId="reasoning-pill"
                        className="absolute inset-0 rounded-md"
                        style={{
                          backgroundColor: accentMix(13),
                          boxShadow: `inset 0 0 0 1px ${accentMix(33)}`,
                        }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      />
                    )}
                    <span className="relative">{r}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="px-4 pt-3 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 px-3 h-9 rounded-lg bg-droid-bg/60 border border-droid-border focus-within:border-droid-border-hover transition-colors">
              <Search className="w-3.5 h-3.5 text-droid-text-muted shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                placeholder={`Search models · ${selectedLabel}`}
                className="flex-1 bg-transparent text-[12px] text-droid-text placeholder-droid-text-muted/70 focus:outline-none"
              />
            </div>
            {harnessId === 'droid' && (
              <ModelCategoryFilter source={source} cat={cat} onSelect={setCat} />
            )}
          </div>

          <ModelCatalogList
            models={models}
            hasRealModels={hasRealModels}
            selectedModelId={effModelId}
            query={query}
            onSelectModel={updateModel}
            disabled={Boolean(childTarget && !childReady)}
            showFactoryDefault={harnessId === 'droid'}
            emptyMessage={
              snapshot?.error?.message ??
              (state.providerSnapshots.length === 0 ? undefined : 'No models advertised')
            }
          />
        </div>
      </div>

      <div className="absolute -bottom-1.5 left-7 w-3 h-3 rotate-45 bg-droid-elevated border-r border-b border-droid-border" />
    </motion.div>
  );
}

function reasoningChoices(
  selectedConfigModel: ModelInfo | undefined,
  selectedSupportedReasoning: ReasoningEffort[] | undefined,
  harnessId: ProviderInstanceId,
  effReasoning: ReasoningEffort,
): ReasoningEffort[] {
  if (!selectedConfigModel) return harnessId === 'droid' ? BASE_REASONING : [];
  if (selectedSupportedReasoning?.length) return selectedSupportedReasoning;
  if (harnessId !== 'droid') return [];
  return [selectedConfigModel.defaultReasoningEffort ?? effReasoning];
}

function persistLiveOrDraft(input: {
  harnessId: ProviderInstanceId;
  scopedAppSessionId?: string;
  activeAppSessionId: string | null;
  configuration?: SessionConfiguration;
  agent: AgentKind;
  patch: { modelId?: string; reasoning?: ReasoningEffort };
}): void {
  if (input.harnessId !== 'droid') {
    if (!input.scopedAppSessionId || !input.configuration) return;
    const options = { ...input.configuration.providerSelection.options };
    if (input.patch.reasoning !== undefined) options.reasoningEffort = input.patch.reasoning;
    updateSessionSettings({
      appSessionId: input.scopedAppSessionId,
      configuration: withProviderSelection(input.configuration, {
        ...(input.patch.modelId ? { modelId: input.patch.modelId } : {}),
        options,
      }),
    });
    return;
  }
  updateAgentSettings({
    appSessionId: input.activeAppSessionId ?? undefined,
    agent: input.agent,
    ...('modelId' in input.patch ? { modelId: input.patch.modelId ?? null } : {}),
    ...('reasoning' in input.patch ? { reasoningEffort: input.patch.reasoning } : {}),
  });
}
