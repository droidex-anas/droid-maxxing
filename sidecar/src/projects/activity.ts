import type { TranscriptEvent } from '../protocol.js';

/** Only the current primary reply is retained; thinking and tool output never enter it. */
export class ProjectActivity {
  private readonly turns = new Map<string, string>();

  start(appSessionId: string): boolean {
    if (this.turns.has(appSessionId)) return false;
    this.turns.set(appSessionId, '');
    return true;
  }

  append(event: TranscriptEvent): void {
    if (event.role !== 'primary' || event.author === 'user') return;
    const text = this.turns.get(event.appSessionId);
    if (text === undefined) return;
    if (event.kind === 'tool_call') {
      // A pre-tool explanation is not the final report.
      this.turns.set(event.appSessionId, '');
    } else if (event.kind === 'text') {
      this.turns.set(event.appSessionId, (text + (event.text ?? '')).slice(-8_192));
    }
  }

  finish(appSessionId: string): string | undefined {
    const text = this.turns.get(appSessionId);
    this.turns.delete(appSessionId);
    return text;
  }

  clear(): void {
    this.turns.clear();
  }
}
