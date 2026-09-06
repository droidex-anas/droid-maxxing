import type { ServerEvent } from '../types/bridge';

export type HistoryPersistenceHealth = 'ok' | 'degraded';
export type HistorySearchHealth = 'ok' | 'unavailable';

export interface HistoryHealthSnapshot {
  persistence: HistoryPersistenceHealth;
  search: HistorySearchHealth;
}

const listeners = new Set<() => void>();

let persistence: HistoryPersistenceHealth = 'ok';
let search: HistorySearchHealth = 'ok';

function emit(): void {
  for (const listener of listeners) listener();
}

export function isHistoryStatusError(event: ServerEvent): boolean {
  return (
    event.type === 'error' &&
    (event.code === 'history.persistence_degraded' || event.code === 'history.search_unavailable')
  );
}

export function applyHistoryServerEvent(event: ServerEvent): void {
  if (event.type === 'history.persistenceRecovered') {
    if (persistence === 'ok') return;
    persistence = 'ok';
    emit();
    return;
  }
  if (event.type === 'error' && event.code === 'history.persistence_degraded') {
    if (persistence === 'degraded') return;
    persistence = 'degraded';
    emit();
    return;
  }
  if (event.type === 'error' && event.code === 'history.search_unavailable') {
    if (search === 'unavailable') return;
    search = 'unavailable';
    emit();
    return;
  }
  if (event.type === 'sessions.searchResults' && search === 'unavailable') {
    search = 'ok';
    emit();
  }
}

export function getHistoryHealth(): HistoryHealthSnapshot {
  return { persistence, search };
}

export function subscribeHistoryHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetHistoryHealthForTests(): void {
  persistence = 'ok';
  search = 'ok';
  emit();
}
