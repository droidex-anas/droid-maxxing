// What a Codex thread is still doing before it can answer. Right after the
// thread opens, Codex reports every configured MCP server starting and then
// settling, and runs the session's hooks, in bursts of notifications that take
// seconds to finish. The turn that is waiting on them says so in one line each,
// and says nothing once it has produced its first item.
import { isObject } from './codexEvents.js';

interface ServerStatus {
  name: string;
  status: string;
}

function serverStatusOf(params: unknown): ServerStatus | undefined {
  if (!isObject(params)) return undefined;
  const { name, status } = params;
  return typeof name === 'string' && typeof status === 'string' ? { name, status } : undefined;
}

export class CodexStartup {
  private readonly starting = new Set<string>();
  private openHooks = 0;
  private announcedServers = false;
  private announcedHooks = false;
  private answering = false;

  // `mcpServer/startupStatus/updated`. Every other status — ready, failed — is
  // the end of that server's startup, whatever the reason.
  serverStatus(params: unknown): void {
    const update = serverStatusOf(params);
    if (!update) return;
    if (update.status === 'starting') this.starting.add(update.name);
    else this.starting.delete(update.name);
  }

  hookStarted(): void {
    this.openHooks += 1;
  }

  hookCompleted(): void {
    if (this.openHooks > 0) this.openHooks -= 1;
  }

  // The turn is producing output, so its startup is no longer what the user is
  // waiting on.
  itemArrived(): void {
    this.answering = true;
  }

  // At most one line per kind for the life of the session. The transcript has no
  // way to replace a status row, so each is stated once, with the count known
  // when the turn asks.
  notices(): string[] {
    if (this.answering) return [];
    const lines: string[] = [];
    if (!this.announcedServers && this.starting.size > 0) {
      this.announcedServers = true;
      lines.push(`Starting MCP servers (${String(this.starting.size)})…`);
    }
    if (!this.announcedHooks && this.openHooks > 0) {
      this.announcedHooks = true;
      lines.push('Running session hooks…');
    }
    return lines;
  }
}
