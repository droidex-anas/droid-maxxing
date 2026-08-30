import { shallowEqual, useStoreDispatch, useStoreSelector } from '../../hooks/useStore';
import { resolveNewChatCwd, type WorkspaceScope } from '../../lib/workspaces';
import { AutomationsView } from './AutomationsView';
import { AUTOMATION_SETUP_PROMPT } from './schedule';

/**
 * Store-connected Automations route. App decides only that this route is
 * visible; the defaults a new automation inherits (workspace, model, reasoning)
 * and the navigation the view triggers stay owned here.
 */
export function AutomationsRoute({
  workspaceScopes,
  workspaceScopesReady,
}: {
  workspaceScopes: readonly WorkspaceScope[];
  workspaceScopesReady: boolean;
}) {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector(
    (current) => ({
      activeSession: current.activeAppSessionId
        ? current.sessions[current.activeAppSessionId]
        : null,
      agentConfig: current.agentConfig,
      automationEditorRequest: current.automationEditorRequest,
      draftChat: current.draftChat,
      models: current.models,
    }),
    shallowEqual,
  );
  const { activeSession } = state;
  // A new automation, like a new chat, follows the active session's workspace.
  const newChatCwd = resolveNewChatCwd(activeSession, state.draftChat);

  return (
    <AutomationsView
      workspaceScopes={workspaceScopes}
      workspaceScopesReady={workspaceScopesReady}
      models={state.models}
      defaultModelId={
        activeSession?.modelId ??
        state.agentConfig.primary.modelId ??
        state.models.find((model) => model.isDefault)?.id ??
        state.models.at(0)?.id ??
        null
      }
      defaultReasoningEffort={activeSession?.reasoningEffort ?? state.agentConfig.primary.reasoning}
      currentWorkspaceCwd={newChatCwd || null}
      onChatWithDroidex={() => {
        dispatch({
          type: 'START_CHAT',
          cwd: newChatCwd,
          executionMode: newChatCwd ? 'worktree' : 'local',
        });
        dispatch({ type: 'SEED_COMPOSER', text: AUTOMATION_SETUP_PROMPT });
      }}
      onOpenSession={(appSessionId) => {
        dispatch({ type: 'SET_ACTIVE_SESSION', id: appSessionId });
        dispatch({ type: 'SELECT_CHILD', selection: null });
      }}
      editorRequest={state.automationEditorRequest}
      onEditorRequestHandled={(requestId) => {
        dispatch({ type: 'AUTOMATION_EDITOR_REQUEST_HANDLED', requestId });
      }}
    />
  );
}
