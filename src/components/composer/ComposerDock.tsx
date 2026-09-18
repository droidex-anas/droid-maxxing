import { useCallback, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { shallowEqual, useStoreSelector, type AppState } from '../../hooks/useStore';
import { currentAgentRun, isWorkingAgentStatus } from '../agents/agentMonitorModel';
import { useOpenAgent } from '../agents/useOpenAgent';
import { AgentDockLine } from './AgentDockLine';
import PlanSteps from './PlanSteps';

/* What sits between the transcript and the composer: the pinned plan, and the
   agent monitor's collapsed line while a run is in flight. Only ever these two,
   and only one of them is expanded — expanding either collapses the other. */

type OpenDock = 'plan' | 'agents' | null;

export default function ComposerDock() {
  const [open, setOpen] = useState<OpenDock>(null);
  const agents = useDockedAgents();
  const openAgent = useOpenAgent();
  // Collapsing only ever closes the line that asked: the plan resets itself on a
  // session switch, and that must not also fold an expanded agents line.
  const showPlan = useCallback((expanded: boolean) => {
    setOpen((current) => nextOpenDock(current, 'plan', expanded));
  }, []);
  const showAgents = useCallback((expanded: boolean) => {
    setOpen((current) => nextOpenDock(current, 'agents', expanded));
  }, []);

  return (
    <>
      <PlanSteps expanded={open === 'plan'} onExpandedChange={showPlan} />
      <AnimatePresence initial={false}>
        {agents && (
          <AgentDockLine
            key="agents"
            sessions={agents.sessions}
            models={agents.models}
            expanded={open === 'agents'}
            onExpandedChange={showAgents}
            onOpen={(child) => {
              openAgent(child.childSessionId);
            }}
            {...(agents.provider !== undefined ? { provider: agents.provider } : {})}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function nextOpenDock(
  current: OpenDock,
  line: Exclude<OpenDock, null>,
  expanded: boolean,
): OpenDock {
  if (expanded) return line;
  return current === line ? null : current;
}

/** The docked line is derived from the session's registered children alone: the
    composer re-renders on every streamed token, and reading the transcript here
    would put a scan of it on that path. Exported so that contract stays
    checkable: appending a transcript event must leave this shallow-equal. */
export function selectDockedAgents(state: AppState) {
  const session = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  // Keyed renderer maps are typed as always-present; Partial keeps the lookup
  // honest without changing runtime behavior.
  const childrenByParent: Partial<typeof state.childSessions> = state.childSessions;
  return {
    children: session ? childrenByParent[session.appSessionId] : undefined,
    models: state.models,
    provider: session?.provider,
    missionControl: session?.sessionPurpose === 'mission-control',
  };
}

function useDockedAgents() {
  const source = useStoreSelector(selectDockedAgents, shallowEqual);

  return useMemo(() => {
    if (!source.children || source.missionControl) return null;
    const sessions = currentAgentRun(Object.values(source.children));
    // Above the composer is how the user knows agents are working right now, so
    // the line follows the agents alone and never the chat's own turn: it docks
    // while the newest wave still has one working and leaves when none does. A
    // finished wave stays in the Subagents panel and the transcript.
    if (!sessions.some((child) => isWorkingAgentStatus(child.status))) return null;
    return {
      sessions,
      models: source.models,
      ...(source.provider !== undefined ? { provider: source.provider } : {}),
    };
  }, [source.children, source.missionControl, source.models, source.provider]);
}
