import type { AutomationDraft, AutomationSnapshot } from './types';

export type AutomationBridgeEvent =
  | { type: 'automations.snapshot'; snapshot: AutomationSnapshot }
  | { type: 'automations.result'; requestId: string; ok: boolean; error?: string };

export type AutomationBridgeCommand =
  | { type: 'automations.list'; requestId: string }
  | { type: 'automations.create'; requestId: string; input: AutomationDraft }
  | {
      type: 'automations.update';
      requestId: string;
      id: string;
      patch: Partial<AutomationDraft>;
    }
  | { type: 'automations.delete'; requestId: string; id: string }
  | { type: 'automations.setEnabled'; requestId: string; id: string; enabled: boolean }
  | { type: 'automations.runNow'; requestId: string; id: string }
  | {
      type: 'automations.confirmProposal';
      requestId: string;
      id: string;
      input?: AutomationDraft;
    };
