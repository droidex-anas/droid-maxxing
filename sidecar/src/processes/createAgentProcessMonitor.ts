import type { AgentProcess } from '../protocol.js';
import {
  AgentProcessMonitor,
  type AgentProcessMonitorDependencies,
} from './AgentProcessMonitor.js';
import { listListeningPorts } from './listeningPorts.js';
import { defaultCommandRunner, listProcesses } from './processTree.js';

// The OS surface the monitor drives. Overridable so integration tests can
// script a process table instead of reading the host's real `ps` and `lsof` —
// and never signal one of the host's own pids.
export type AgentProcessHost = Pick<
  AgentProcessMonitorDependencies,
  'listProcesses' | 'listListeningPorts' | 'kill'
>;

export type CreateAgentProcessMonitorOptions = Partial<AgentProcessHost> & {
  emit: (appSessionId: string, processes: AgentProcess[]) => void;
};

export function createAgentProcessMonitor(
  options: CreateAgentProcessMonitorOptions,
): AgentProcessMonitor {
  return new AgentProcessMonitor({
    listProcesses: options.listProcesses ?? (() => listProcesses(defaultCommandRunner, Date.now)),
    listListeningPorts:
      options.listListeningPorts ?? (() => listListeningPorts(defaultCommandRunner)),
    kill:
      options.kill ??
      ((pid, signal) => {
        process.kill(pid, signal);
      }),
    emit: options.emit,
    // Unref'd: the scan tick must never be the reason the process stays up.
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return {
        cancel: () => {
          clearTimeout(timer);
        },
      };
    },
    now: Date.now,
  });
}
