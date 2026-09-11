import type { AgentProcess } from '../protocol.js';
import {
  AgentProcessMonitor,
  type AgentProcessMonitorDependencies,
} from './AgentProcessMonitor.js';
import { listListeningPorts } from './listeningPorts.js';
import { defaultCommandRunner, listProcesses, tolerantCommandRunner } from './processTree.js';

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

function scheduleTimer(callback: () => void, ms: number, referenced: boolean): { cancel(): void } {
  const timer = setTimeout(callback, ms);
  if (!referenced) timer.unref();
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

export function createAgentProcessMonitor(
  options: CreateAgentProcessMonitorOptions,
): AgentProcessMonitor {
  return new AgentProcessMonitor({
    listProcesses: options.listProcesses ?? (() => listProcesses(defaultCommandRunner, Date.now)),
    listListeningPorts:
      options.listListeningPorts ?? (() => listListeningPorts(tolerantCommandRunner)),
    kill:
      options.kill ??
      ((pid, signal) => {
        process.kill(pid, signal);
      }),
    emit: options.emit,
    // Unref'd: the scan tick must never be the reason the process stays up.
    schedule: (callback, ms) => scheduleTimer(callback, ms, false),
    // Referenced: the kill grace poll runs during shutdown, and an unref'd
    // timer there lets the loop exit mid-kill and skip the SIGKILL sweep.
    scheduleKillPoll: (callback, ms) => scheduleTimer(callback, ms, true),
    now: Date.now,
  });
}
