import { randomUUID } from 'node:crypto';
import type { SessionManager } from '../SessionManager.js';
import type { ServerEvent, SessionSummary } from '../protocol.js';
import type { ProjectPort } from './ProjectService.js';
import type { ThreadInput } from './types.js';

interface Launch {
  bind: (session: SessionSummary) => Promise<void>;
  session?: SessionSummary;
  error?: string;
}

type Host = Pick<SessionManager, 'handle' | 'sessionSummary' | 'deliverScheduledMessage'>;

/** Correlates session creation and commits membership before the first provider turn. */
export class ProjectSessions implements ProjectPort {
  private readonly launching = new Map<string, Launch>();

  constructor(private readonly host: Host) {}

  get(appSessionId: string): SessionSummary | undefined {
    return this.host.sessionSummary(appSessionId);
  }

  async create(input: ThreadInput, bind: Launch['bind']): Promise<SessionSummary | undefined> {
    const clientRef = `project:${randomUUID()}`;
    const launch: Launch = { bind };
    this.launching.set(clientRef, launch);
    try {
      const { prompt, ...settings } = input;
      await this.host.handle({
        ...settings,
        type: 'session.create',
        clientRef,
        goal: prompt,
        sessionPurpose: 'chat',
        interactionMode: 'auto',
      });
      if (launch.error) throw new Error(launch.error);
      return launch.session;
    } finally {
      this.launching.delete(clientRef);
    }
  }

  async beforeFirstTurn(session: SessionSummary, clientRef: string): Promise<void> {
    const launch = this.launching.get(clientRef);
    if (!launch) return;
    await launch.bind(session);
    launch.session = session;
  }

  observe(event: ServerEvent): void {
    if (event.type !== 'error' || !event.clientRef) return;
    const launch = this.launching.get(event.clientRef);
    if (launch) launch.error = event.message;
  }

  deliver(appSessionId: string, prompt: string, isCurrent: () => boolean) {
    return this.host.deliverScheduledMessage(appSessionId, prompt, isCurrent);
  }

  interrupt(appSessionId: string): Promise<void> {
    return this.host.handle({ type: 'session.interrupt', appSessionId });
  }
}
