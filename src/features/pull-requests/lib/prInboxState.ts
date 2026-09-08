import { resolvePrWorkspaceNumber } from './prWorkspaceCwd';
import { addPrBacklogId, removePrBacklogId } from './prBacklog';
import type { MainView } from '../../../hooks/persistedUiPreferences';

export type PrInboxAction =
  | { type: 'OPEN_PULL_REQUESTS'; cwd?: string | null; number?: number | null }
  | { type: 'CLOSE_PULL_REQUESTS' }
  | { type: 'MOVE_PR_TO_BACKLOG'; id: string }
  | { type: 'RESTORE_PR_FROM_BACKLOG'; id: string };

export interface PrInboxSlice {
  mainView: MainView;
  prWorkspaceCwd: string | null;
  prWorkspaceNumber: number | null;
  prBacklogIds: string[];
}

export function reducePrInbox<S extends PrInboxSlice>(state: S, action: PrInboxAction): S {
  switch (action.type) {
    case 'OPEN_PULL_REQUESTS':
      return {
        ...state,
        mainView: 'pull-requests',
        prWorkspaceCwd: action.cwd === undefined ? state.prWorkspaceCwd : action.cwd,
        prWorkspaceNumber: resolvePrWorkspaceNumber(
          state.prWorkspaceCwd,
          state.prWorkspaceNumber,
          action.cwd,
          action.number,
        ),
      };
    case 'CLOSE_PULL_REQUESTS':
      return state.mainView === 'session' ? state : { ...state, mainView: 'session' };
    case 'MOVE_PR_TO_BACKLOG': {
      const prBacklogIds = addPrBacklogId(state.prBacklogIds, action.id);
      return prBacklogIds ? { ...state, prBacklogIds } : state;
    }
    case 'RESTORE_PR_FROM_BACKLOG': {
      const prBacklogIds = removePrBacklogId(state.prBacklogIds, action.id);
      return prBacklogIds ? { ...state, prBacklogIds } : state;
    }
  }
}
