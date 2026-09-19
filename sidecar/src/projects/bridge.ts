import { z } from 'zod';
import type { ServerEvent } from '../protocol.js';
import type { ProjectService } from './ProjectService.js';
import { threadInputSchema } from './store.js';
import type { ProjectEvent } from './types.js';

const id = z.string().min(1).max(200);
const requestId = { requestId: id };
const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('projects.list') }).strict(),
  z.object({ type: z.literal('project.create'), ...requestId, input: threadInputSchema }).strict(),
  z
    .object({
      type: z.literal('project.spawn'),
      ...requestId,
      source: id,
      input: threadInputSchema.omit({ cwd: true }),
    })
    .strict(),
  z
    .object({
      type: z.literal('project.send'),
      ...requestId,
      source: id,
      target: id,
      text: z.string().trim().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal('project.ask'),
      ...requestId,
      source: id,
      text: z.string().trim().min(1).max(8_192),
    })
    .strict(),
  z.object({ type: z.literal('project.stop'), ...requestId, source: id, target: id }).strict(),
  z
    .object({
      type: z.literal('project.pause'),
      ...requestId,
      projectId: id,
      paused: z.boolean(),
      acknowledgeDelivery: z.boolean().optional(),
    })
    .strict(),
]);

type Command = z.infer<typeof commandSchema>;
type Reply = Extract<ProjectEvent, { type: 'project.result' }>;

export function createProjectCommandHandler(
  ready: Promise<ProjectService>,
  emit: (event: ServerEvent) => void,
): (command: unknown) => Promise<boolean> {
  const requests = new Map<string, { input: string; reply: Promise<Reply>; settled: boolean }>();
  return async (value) => {
    if (!isProjectRequest(value)) return false;
    const parsed = commandSchema.safeParse(value);
    if (!parsed.success) {
      if ('requestId' in value && typeof value.requestId === 'string') {
        emit({
          type: 'project.result',
          requestId: value.requestId,
          ok: false,
          error: 'Invalid Projects command.',
        });
      } else {
        emit({
          type: 'error',
          code: 'project.invalid_command',
          message: 'Invalid Projects command.',
        });
      }
      return true;
    }
    const command = parsed.data;
    if (command.type === 'projects.list') {
      try {
        (await ready).publish();
      } catch (error) {
        emit({ type: 'error', code: 'project.load_failed', message: errorMessage(error) });
      }
      return true;
    }
    const serialized = JSON.stringify(command);
    let request = requests.get(command.requestId);
    if (request && request.input !== serialized) {
      emit({
        type: 'project.result',
        requestId: command.requestId,
        ok: false,
        error: 'Request identity was reused with different arguments.',
      });
      return true;
    }
    if (!request) {
      for (const [key, entry] of requests) {
        if (requests.size < 128) break;
        if (entry.settled) requests.delete(key);
      }
      if (requests.size >= 128) {
        emit({
          type: 'project.result',
          requestId: command.requestId,
          ok: false,
          error: 'Too many pending Projects requests.',
        });
        return true;
      }
      const reply = runCommand(ready, command);
      const entry = { input: serialized, reply, settled: false };
      requests.set(command.requestId, entry);
      void reply.then(() => {
        entry.settled = true;
      });
      request = entry;
    }
    emit(await request.reply);
    return true;
  };
}

async function runCommand(
  ready: Promise<ProjectService>,
  command: Exclude<Command, { type: 'projects.list' }>,
): Promise<Reply> {
  try {
    const projects = await ready;
    let projectId: string | undefined;
    let appSessionId: string | undefined;
    switch (command.type) {
      case 'project.create':
        projectId = await projects.create(command.input, command.requestId);
        break;
      case 'project.spawn':
        ({ appSessionId } = await projects.spawn(command.source, command.input));
        break;
      case 'project.send':
        await projects.send(command.source, command.target, command.text);
        break;
      case 'project.ask':
        await projects.ask(command.source, command.text);
        break;
      case 'project.stop':
        await projects.stop(command.source, command.target);
        break;
      case 'project.pause':
        await projects.setPaused(command.projectId, command.paused, command.acknowledgeDelivery);
        projectId = command.projectId;
        break;
    }
    return {
      type: 'project.result',
      requestId: command.requestId,
      ok: true,
      ...(projectId ? { projectId } : {}),
      ...(appSessionId ? { appSessionId } : {}),
    };
  } catch (error) {
    return {
      type: 'project.result',
      requestId: command.requestId,
      ok: false,
      error: errorMessage(error),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProjectRequest(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string')
    return false;
  return value.type.startsWith('project.') || value.type.startsWith('projects.');
}
