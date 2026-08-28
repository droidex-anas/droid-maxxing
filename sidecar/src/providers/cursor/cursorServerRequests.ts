// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/CursorAdapter.ts
// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/CursorAcpExtension.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import type { AcpServerRequest } from '../acp/AcpConnection.js';
import type { Autonomy } from '../../protocol.js';
import { createProviderContractError } from '../providerTypes.js';
import type { ProviderIdSource, ProviderInteractionSink } from '../providerTypes.js';
import type { SessionTarget } from '../providerIdentity.js';
import {
  cursorCreatePlanAcpResult,
  parseCursorAskQuestion,
  parseCursorCreatePlan,
  parseCursorUpdateTodos,
  questionRequestFromAskQuestion,
  reconstructCursorAskQuestionAnswers,
  type CursorParsedAskQuestion,
  type CursorParsedUpdateTodos,
} from './cursorExtensions.js';
import type { CursorPendingRegistry } from './cursorPending.js';
import {
  CURSOR_PERMISSION_CANCELLED_RESULT,
  mapApprovalDecisionToAcpResult,
  parseCursorPermissionRequest,
  selectAdvertisedAllowOptionId,
  shouldAutoApproveAcpKind,
} from './cursorPermissions.js';

export interface CursorServerRequestContext {
  runtimeGeneration: number;
  autonomy: Autonomy;
  isLive: () => boolean;
  interactionSink: ProviderInteractionSink;
  ids: ProviderIdSource;
  target: SessionTarget;
  pending: CursorPendingRegistry;
  onUpdateTodos: (parsed: CursorParsedUpdateTodos) => void;
}

export async function handleCursorAcpServerRequest(
  request: AcpServerRequest,
  ctx: CursorServerRequestContext,
): Promise<unknown> {
  switch (request.method) {
    case 'session/request_permission':
      return handlePermission(request, ctx);
    case 'cursor/ask_question':
      return handleAskQuestion(request, ctx);
    case 'cursor/create_plan':
      return handleCreatePlan(request, ctx);
    case 'cursor/update_todos':
      return handleUpdateTodosRequest(request, ctx);
    default:
      throw invalidCursorExtension();
  }
}

async function handlePermission(
  request: AcpServerRequest,
  ctx: CursorServerRequestContext,
): Promise<unknown> {
  const parsed = parseCursorPermissionRequest(request.params);
  if (!parsed) {
    throw invalidCursorExtension();
  }
  if (shouldAutoApproveAcpKind(ctx.autonomy, parsed.acpKind)) {
    const optionId = selectAdvertisedAllowOptionId(parsed.options);
    if (optionId !== undefined) {
      return { outcome: { outcome: 'selected', optionId } };
    }
  }
  const requestId = ctx.ids.nextEventId();
  const waiter = ctx.pending.open<unknown>(requestId, CURSOR_PERMISSION_CANCELLED_RESULT);
  const runtimeGeneration = ctx.runtimeGeneration;
  void ctx.interactionSink
    .requestApproval({
      requestId,
      target: ctx.target,
      runtimeGeneration,
      kind: parsed.permissionKind,
      title: parsed.title,
      detail: parsed.detail,
      options: parsed.options.map((option) => option.name ?? option.optionId),
    })
    .then(
      (decision) => {
        if (!ctx.isLive() || runtimeGeneration !== ctx.runtimeGeneration) {
          ctx.pending.complete(requestId, waiter, CURSOR_PERMISSION_CANCELLED_RESULT);
          return;
        }
        ctx.pending.complete(
          requestId,
          waiter,
          mapApprovalDecisionToAcpResult(decision, parsed.options),
        );
      },
      () => {
        ctx.pending.complete(requestId, waiter, CURSOR_PERMISSION_CANCELLED_RESULT);
      },
    );
  return waiter.promise;
}

async function handleAskQuestion(
  request: AcpServerRequest,
  ctx: CursorServerRequestContext,
): Promise<unknown> {
  const parsed = parseCursorAskQuestion(request.params);
  if (!parsed) {
    throw invalidCursorExtension();
  }
  return awaitQuestion(parsed, ctx);
}

async function handleCreatePlan(
  request: AcpServerRequest,
  ctx: CursorServerRequestContext,
): Promise<unknown> {
  const parsed = parseCursorCreatePlan(request.params);
  if (!parsed) {
    throw invalidCursorExtension();
  }
  const requestId = ctx.ids.nextEventId();
  const waiter = ctx.pending.open<unknown>(
    requestId,
    cursorCreatePlanAcpResult({ decision: 'cancel' }),
  );
  const runtimeGeneration = ctx.runtimeGeneration;
  void ctx.interactionSink
    .requestPlanReview({
      requestId,
      target: ctx.target,
      runtimeGeneration,
      plan: parsed.plan,
    })
    .then(
      (decision) => {
        if (!ctx.isLive() || runtimeGeneration !== ctx.runtimeGeneration) {
          ctx.pending.complete(
            requestId,
            waiter,
            cursorCreatePlanAcpResult({ decision: 'cancel' }),
          );
          return;
        }
        ctx.pending.complete(requestId, waiter, cursorCreatePlanAcpResult(decision));
      },
      () => {
        ctx.pending.complete(requestId, waiter, cursorCreatePlanAcpResult({ decision: 'cancel' }));
      },
    );
  return waiter.promise;
}

function handleUpdateTodosRequest(
  request: AcpServerRequest,
  ctx: CursorServerRequestContext,
): unknown {
  const parsed = parseCursorUpdateTodos(request.params);
  if (!parsed) {
    throw invalidCursorExtension();
  }
  ctx.onUpdateTodos(parsed);
  return {};
}

async function awaitQuestion(
  parsed: CursorParsedAskQuestion,
  ctx: CursorServerRequestContext,
): Promise<unknown> {
  const requestId = ctx.ids.nextEventId();
  const cancelValue = reconstructCursorAskQuestionAnswers(parsed.questions, {
    status: 'cancelled',
  });
  const waiter = ctx.pending.open<unknown>(requestId, cancelValue);
  const runtimeGeneration = ctx.runtimeGeneration;
  void ctx.interactionSink
    .requestQuestion({
      requestId,
      target: ctx.target,
      runtimeGeneration,
      questions: questionRequestFromAskQuestion(parsed),
    })
    .then(
      (answer) => {
        if (!ctx.isLive() || runtimeGeneration !== ctx.runtimeGeneration) {
          ctx.pending.complete(
            requestId,
            waiter,
            reconstructCursorAskQuestionAnswers(parsed.questions, { status: 'cancelled' }),
          );
          return;
        }
        ctx.pending.complete(
          requestId,
          waiter,
          reconstructCursorAskQuestionAnswers(parsed.questions, answer),
        );
      },
      () => {
        ctx.pending.complete(
          requestId,
          waiter,
          reconstructCursorAskQuestionAnswers(parsed.questions, { status: 'cancelled' }),
        );
      },
    );
  return waiter.promise;
}

function invalidCursorExtension(): Error {
  return createProviderContractError(
    'cursor',
    'incompatible_provider_protocol',
    'Cursor extension request was invalid.',
    'retry_session',
  );
}
