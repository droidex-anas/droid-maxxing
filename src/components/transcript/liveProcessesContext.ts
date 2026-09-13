import { createContext } from 'react';
import type { AgentProcess } from '../../types/bridge';

// The transcript's leaf cards read the session's live agent processes from
// here rather than from the store, so a card can render standalone (tests,
// previews) without a StoreProvider. ChatView provides the real list.
export const LiveProcessesContext = createContext<readonly AgentProcess[]>([]);
