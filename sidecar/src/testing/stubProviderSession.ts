import type {
  ProviderSession,
  ProviderSteerInput,
  ProviderTurnInput,
} from '../providers/providerTypes.js';
import type { ShutdownDeadline } from '../providers/shutdownDeadline.js';

export class StubProviderSession implements ProviderSession {
  readonly providerSessionId: string;
  readonly initialResumeState: unknown = null;

  constructor(sessionId: string) {
    this.providerSessionId = sessionId;
  }

  activate(): void {}

  startTurn(_input: ProviderTurnInput): Promise<void> {
    return Promise.reject(new Error('stub provider session does not start turns'));
  }

  steer(_input: ProviderSteerInput): Promise<void> {
    return Promise.reject(new Error('stub provider session does not steer'));
  }

  interrupt(_input: { turnId: string; runtimeGeneration: number }): Promise<void> {
    return Promise.resolve();
  }

  close(_deadline: ShutdownDeadline): Promise<void> {
    return Promise.resolve();
  }
}
