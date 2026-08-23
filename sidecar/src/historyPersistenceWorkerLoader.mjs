import { register } from 'tsx/esm/api';

register();
await import('./historyPersistenceWorker.ts');
