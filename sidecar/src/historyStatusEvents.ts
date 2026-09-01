import type { HistoryPersistenceStatus } from './HistoryPersistence.js';
import type { ServerEvent } from './protocol.js';

export function serverEventForHistoryStatus(status: HistoryPersistenceStatus): ServerEvent {
  switch (status.state) {
    case 'healthy':
      return { type: 'history.persistenceRecovered' };
    case 'search_unavailable':
      return {
        type: 'error',
        code: 'history.search_unavailable',
        message:
          `History search is unavailable: ${status.message} ` +
          'Canonical session history is unaffected.',
        recoverable: false,
      };
    case 'degraded':
      return {
        type: 'error',
        code: 'history.persistence_degraded',
        message:
          `History durability is temporarily degraded: ${status.message} ` +
          'Live work will continue while buffered capacity remains; settlement will retry.',
        recoverable: true,
      };
  }
}
