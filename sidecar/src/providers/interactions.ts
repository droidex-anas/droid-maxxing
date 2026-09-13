import type { PermissionOutcome, PermissionRequest, SessionQuestion } from '../protocol.js';

// An approval a provider runtime needs from the user, in DROIDEX's own terms:
// the request the renderer receives, plus what the session layer decides with.
export interface ProviderApprovalRequest {
  request: PermissionRequest;
  // Provider confirmation discriminator; drives the mission phase transitions.
  confirmationType: string;
  // Stable key for an always-allow grant; absent when the request cannot earn one.
  signature?: string;
  // Set when the request targets a DROIDEX automation MCP tool.
  automationTool?: { serverName: string; toolName: string };
}

export interface ProviderQuestionAnswers {
  cancelled: boolean;
  answers: { index: number; question: string; answer: string }[];
}

// A session's side of the user interactions a provider runtime needs. Provider
// adapters translate their own callbacks into these two calls and nothing else.
export interface ProviderInteractions {
  requestApproval(approval: ProviderApprovalRequest): Promise<PermissionOutcome>;
  requestQuestion(questions: SessionQuestion['questions']): Promise<ProviderQuestionAnswers>;
}

// One sequence for every interaction request, so two providers in the same
// runtime can never mint the same request id.
let requestSequence = 0;
export function nextInteractionRequestId(): string {
  return `req-${Date.now().toString(36)}-${(requestSequence++).toString(36)}`;
}
