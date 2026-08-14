import type { BrowserTranscriptReference, TranscriptEvent } from '../types/bridge';

export const newQueueId = () => `q-${String(Date.now())}-${Math.random().toString(36).slice(2, 7)}`;

export interface PromptQueueDeliveryGuard {
  run: (deliver: () => Promise<void>) => Promise<boolean>;
}

export function createPromptQueueDeliveryGuard(): PromptQueueDeliveryGuard {
  let isDelivering = false;
  return {
    async run(deliver) {
      if (isDelivering) return false;
      isDelivering = true;
      try {
        await deliver();
        return true;
      } finally {
        isDelivering = false;
      }
    },
  };
}

export function createLocalDesignTranscriptEvent(
  appSessionId: string,
  text: string,
  browserRefs: BrowserTranscriptReference[],
): TranscriptEvent {
  return {
    id: `local-design-${String(Date.now())}`,
    appSessionId,
    sourceSessionId: 'user',
    role: 'primary',
    ts: Date.now(),
    kind: 'text',
    text,
    author: 'user',
    browserRefs: browserRefs.length ? browserRefs : undefined,
  };
}
