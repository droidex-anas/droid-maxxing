import { tool } from '@factory/droid-sdk';
import { z } from 'zod';
import { jsonResult, safeTool } from '../mcpToolUtils.js';
import { getAutomationManager } from './AutomationManager.js';
import type { AutomationInput, AutomationPatch } from './types.js';
import { deriveAutomationTitle } from './title.js';

const reasoningSchema = z.enum([
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'dynamic',
]);

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    runAt: z.number().int().positive().describe('Absolute Unix timestamp in milliseconds.'),
  }),
  z.object({ kind: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
  z.object({
    kind: z.literal('daily'),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .describe('Local 24-hour time, HH:mm.'),
  }),
  z.object({
    kind: z.literal('weekdays'),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .describe('Local 24-hour time, HH:mm.'),
  }),
  z.object({
    kind: z.literal('weekly'),
    weekday: z.number().int().min(0).max(6).describe('0 Sunday through 6 Saturday.'),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .describe('Local 24-hour time, HH:mm.'),
  }),
  z.object({
    kind: z.literal('cron'),
    expression: z.string().min(5).max(120).describe('Standard five-field cron expression.'),
  }),
]);

const titleSchema = z.string().min(1).max(120);
const promptSchema = z
  .string()
  .min(1)
  .max(20_000)
  .describe('Complete instructions for what DROIDEX should do on every run.');
const sharedInput = {
  title: titleSchema
    .optional()
    .describe('Optional short title. DROIDEX derives one from the instructions when omitted.'),
  prompt: promptSchema,
  workspaceCwd: z
    .string()
    .max(4096)
    .nullable()
    .optional()
    .describe(
      'Workspace path. Omit to inherit this chat workspace; pass null for a folder-less chat.',
    ),
  executionMode: z
    .enum(['local', 'worktree'])
    .optional()
    .describe('Use worktree for isolated code-changing work; otherwise use the current checkout.'),
  enabled: z.boolean().optional().describe('Whether the schedule starts active. Defaults to true.'),
  schedule: scheduleSchema.describe(
    'The complete schedule. Examples: {kind:"daily",time:"09:00"}, {kind:"weekdays",time:"08:30"}, or {kind:"weekly",weekday:1,time:"09:00"}.',
  ),
  timezone: z
    .string()
    .optional()
    .describe('IANA timezone such as Asia/Kolkata. Omit to use the device timezone.'),
  modelId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Omit to inherit the exact model used by this chat.'),
  reasoningEffort: reasoningSchema
    .nullable()
    .optional()
    .describe('Omit to inherit the reasoning level used by this chat.'),
  autonomy: z
    .enum(['off', 'low', 'medium', 'high'])
    .optional()
    .describe("Omit to inherit this chat's autonomy. Defaults to low for unattended runs."),
};

type ConversationalAutomationInput = Omit<AutomationInput, 'title'> & { title?: string };

export function createAutomationMcpTools(options: { appSessionId: () => string }) {
  return [
    tool(
      'automation_propose',
      [
        'Prepare one DROIDEX automation proposal and show its native review card inside this chat.',
        'Tool path: user request → automation_propose → DROIDEX review card → user edits or confirms.',
        'Use this once for normal conversational scheduling requests. Do not retry after an ok result.',
        'Only prompt and schedule are essential. Omit title to let DROIDEX derive it, and omit workspace, model, reasoning, autonomy, or timezone to inherit the current chat and device settings.',
        'The proposal is not active until the user presses Confirm automation.',
        'Never use browser control, app control, shell cron, or launchd as a substitute.',
        'After an ok result, briefly tell the user the card is ready and wait for their confirmation.',
      ].join(' '),
      sharedInput,
      safeTool(async (input: ConversationalAutomationInput) => {
        const proposal = await getAutomationManager().propose(
          completeToolInput(input),
          options.appSessionId(),
        );
        return jsonResult({
          ok: true,
          proposalId: proposal.id,
          state: proposal.missingFields.length > 0 ? 'needs_review' : 'ready',
          missing: proposal.missingFields,
          nextAction: 'wait_for_user_confirmation',
          message: 'DROIDEX displayed the automation review card. Nothing is scheduled yet.',
        });
      }),
    ),
    tool(
      'automation_list',
      'Read compact summaries of saved DROIDEX automations and recent run states.',
      {},
      safeTool(async () => {
        const snapshot = await getAutomationManager().snapshot();
        return jsonResult({
          ok: true,
          automations: snapshot.automations.map((automation) => ({
            id: automation.id,
            title: automation.title,
            enabled: automation.enabled,
            schedule: automation.schedule,
            timezone: automation.timezone,
            modelId: automation.modelId,
            reasoningEffort: automation.reasoningEffort,
            autonomy: automation.autonomy,
            nextRunAt: automation.nextRunAt,
            lastRunStatus: automation.lastRunStatus,
            lastRunError: automation.lastRunError,
          })),
          recentRuns: snapshot.runs.slice(0, 20).map((run) => ({
            id: run.id,
            automationId: run.automationId,
            title: run.automation.title,
            status: run.status,
            trigger: run.trigger,
            requestedAt: run.requestedAt,
            appSessionId: run.appSessionId,
            error: run.error,
          })),
        });
      }),
    ),
    tool(
      'automation_create',
      [
        'Create a DROIDEX automation immediately without a review card.',
        'Use only when this chat is in High autonomy and the user clearly requested direct creation or already confirmed every detail.',
        'Otherwise use automation_propose. Do not call both tools for the same request.',
        'Omitted title, workspace, model, reasoning, autonomy, and timezone inherit or derive from this chat.',
      ].join(' '),
      sharedInput,
      safeTool(async (input: ConversationalAutomationInput) => {
        const automation = await getAutomationManager().createFromSession(
          completeToolInput(input),
          options.appSessionId(),
        );
        // A `once` time that already passed leaves no upcoming run, so the
        // result must not claim the automation is scheduled.
        const scheduled = automation.nextRunAt !== null;
        return jsonResult({
          ok: true,
          automationId: automation.id,
          title: automation.title,
          state: scheduled ? 'scheduled' : 'no_upcoming_run',
          nextRunAt: automation.nextRunAt,
          ...(scheduled
            ? {}
            : {
                message:
                  'The automation was saved but has no upcoming run. Update its schedule to a future time.',
              }),
        });
      }),
    ),
    tool(
      'automation_update',
      'Update an existing DROIDEX automation while preserving fields the user did not ask to change.',
      {
        id: z.string().uuid(),
        title: titleSchema.optional(),
        prompt: promptSchema.optional(),
        workspaceCwd: sharedInput.workspaceCwd,
        executionMode: sharedInput.executionMode,
        enabled: sharedInput.enabled,
        schedule: scheduleSchema.optional(),
        timezone: sharedInput.timezone,
        modelId: z.string().min(1).nullable().optional(),
        reasoningEffort: reasoningSchema.nullable().optional(),
        autonomy: z.enum(['off', 'low', 'medium', 'high']).optional(),
      },
      safeTool(async ({ id, ...patch }: { id: string } & AutomationPatch) => {
        const automation = await getAutomationManager().update(id, patch);
        return jsonResult({ ok: true, automationId: automation.id, title: automation.title });
      }),
    ),
    tool(
      'automation_set_enabled',
      'Pause or resume a DROIDEX automation.',
      { id: z.string().uuid(), enabled: z.boolean() },
      safeTool(async (input: { id: string; enabled: boolean }) => {
        const automation = await getAutomationManager().setEnabled(input.id, input.enabled);
        return jsonResult({ ok: true, automationId: automation.id, enabled: automation.enabled });
      }),
    ),
    tool(
      'automation_run_now',
      'Run an existing DROIDEX automation now. It starts automatically when no other automation is active.',
      { id: z.string().uuid() },
      safeTool(async (input: { id: string }) => {
        const run = await getAutomationManager().runNow(input.id);
        return jsonResult({ ok: true, runId: run.id, status: run.status });
      }),
    ),
    tool(
      'automation_delete',
      'Delete a DROIDEX automation only after the user clearly asks to remove it.',
      { id: z.string().uuid() },
      safeTool(async (input: { id: string }) => {
        await getAutomationManager().remove(input.id);
        return jsonResult({ ok: true, deleted: input.id });
      }),
    ),
  ];
}

function completeToolInput(input: ConversationalAutomationInput): AutomationInput {
  const title = input.title?.trim();
  return {
    ...input,
    title: title === undefined || title === '' ? deriveAutomationTitle(input.prompt) : title,
  };
}
