import { DatabaseSync } from 'node:sqlite';
import { register } from 'tsx/esm/api';

const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function execWithoutFts5(sql) {
  if (typeof sql === 'string' && /using\s+fts5/i.test(sql)) {
    throw new Error('no such module: fts5');
  }
  return exec.call(this, sql);
};

register();
await import('../historyPersistenceWorker.ts');
