import { z } from 'zod';

import {
  CONFIGURABLE_SESSION_ROLES,
  PERMISSION_OUTCOMES,
  RESPONSE_FORMATS,
  SESSION_PURPOSES,
  type ClientCommand,
} from '../protocol.js';
import {
  droidMissionConfigurationSchema,
  reasoningEffortSchema,
} from '../providers/providerIdentity.js';
import {
  boundedArray,
  idStringSchema,
  inboundSessionConfigurationSchema,
  modelIdStringSchema,
  optionalCompactionTokenLimitPerModelSchema,
  optionalCompactionTokenLimitSchema,
  optionalHistoryLimitSchema,
  optionalIdStringSchema,
  optionalPathStringSchema,
  optionalTitleStringSchema,
  pathStringSchema,
  promptStringSchema,
  strictCommand,
  titleStringSchema,
  utf8ByteString,
  MAX_LABEL_BYTES,
} from './commandBounds.js';

const responseFormatSchema = z.enum(RESPONSE_FORMATS);
const optionalResponseFormatSchema = responseFormatSchema.optional();
const sessionPurposeSchema = z.enum(SESSION_PURPOSES);
const permissionOutcomeSchema = z.enum(PERMISSION_OUTCOMES);
const configurableSessionRoleSchema = z.enum(CONFIGURABLE_SESSION_ROLES);
const optionalReasoningEffortSchema = reasoningEffortSchema.optional();
const nullableModelIdSchema = z.union([modelIdStringSchema, z.null()]);

const questionAnswerSchema = z
  .object({
    index: z.number().int().nonnegative(),
    question: promptStringSchema,
    answer: promptStringSchema,
  })
  .strict();

export const sessionCommandSchemas = {
  'catalog.models': strictCommand('catalog.models', {}),
  'catalog.tools': strictCommand('catalog.tools', {
    providerSessionId: optionalIdStringSchema,
  }),
  'catalog.skills': strictCommand('catalog.skills', {
    providerSessionId: optionalIdStringSchema,
  }),
  'settings.defaults': strictCommand('settings.defaults', {}),
  'settings.agent.update': strictCommand('settings.agent.update', {
    appSessionId: optionalIdStringSchema,
    agent: configurableSessionRoleSchema,
    modelId: nullableModelIdSchema.optional(),
    reasoningEffort: optionalReasoningEffortSchema,
  }),
  'settings.compaction.update': strictCommand('settings.compaction.update', {
    compactionTokenLimit: optionalCompactionTokenLimitSchema,
    compactionTokenLimitPerModel: optionalCompactionTokenLimitPerModelSchema,
  }),
  'session.create': strictCommand('session.create', {
    clientRef: idStringSchema,
    cwd: optionalPathStringSchema,
    title: titleStringSchema,
    goal: promptStringSchema,
    sessionPurpose: sessionPurposeSchema,
    configuration: inboundSessionConfigurationSchema,
    droidMissionConfiguration: droidMissionConfigurationSchema.optional(),
    compactionModel: modelIdStringSchema.optional(),
    compactionTokenLimit: optionalCompactionTokenLimitSchema,
    compactionTokenLimitPerModel: optionalCompactionTokenLimitPerModelSchema,
    responseFormat: optionalResponseFormatSchema,
  }),
  'session.send': strictCommand('session.send', {
    appSessionId: idStringSchema,
    text: promptStringSchema,
    responseFormat: optionalResponseFormatSchema,
  }),
  'session.sendNow': strictCommand('session.sendNow', {
    appSessionId: idStringSchema,
    text: promptStringSchema,
    responseFormat: optionalResponseFormatSchema,
  }),
  'session.resume': strictCommand('session.resume', {
    appSessionId: idStringSchema,
  }),
  'session.interrupt': strictCommand('session.interrupt', {
    appSessionId: idStringSchema,
  }),
  'session.updateSettings': strictCommand('session.updateSettings', {
    appSessionId: idStringSchema,
    configuration: inboundSessionConfigurationSchema,
  }),
  'session.compact': strictCommand('session.compact', {
    appSessionId: idStringSchema,
    customInstructions: promptStringSchema.optional(),
  }),
  'session.fork': strictCommand('session.fork', {
    appSessionId: idStringSchema,
  }),
  'session.rename': strictCommand('session.rename', {
    appSessionId: idStringSchema,
    title: titleStringSchema,
  }),
  'session.exportMarkdown': strictCommand('session.exportMarkdown', {
    appSessionId: idStringSchema,
    requestId: idStringSchema,
    title: optionalTitleStringSchema,
  }),
  'sessions.reanchorCwd': strictCommand('sessions.reanchorCwd', {
    requestId: idStringSchema,
    fromCwd: pathStringSchema,
    toCwd: pathStringSchema,
  }),
  'session.rewindInfo': strictCommand('session.rewindInfo', {
    appSessionId: idStringSchema,
  }),
  'session.rewind': strictCommand('session.rewind', {
    appSessionId: idStringSchema,
    rewindId: optionalIdStringSchema,
  }),
  'session.close': strictCommand('session.close', {
    appSessionId: idStringSchema,
  }),
  'sessions.list': strictCommand('sessions.list', {
    workspaceCwds: boundedArray(pathStringSchema).optional(),
    includePlainChats: z.boolean().optional(),
    revealEarlierCwds: boundedArray(pathStringSchema).optional(),
  }),
  'session.loadHistory': strictCommand('session.loadHistory', {
    appSessionId: idStringSchema,
    cursor: optionalIdStringSchema,
    limit: optionalHistoryLimitSchema,
  }),
  'sessions.search': strictCommand('sessions.search', {
    requestId: idStringSchema,
    query: utf8ByteString(MAX_LABEL_BYTES),
  }),
  'history.indexingIdle': strictCommand('history.indexingIdle', {
    isIdle: z.boolean(),
  }),
  'history.list': strictCommand('history.list', {}),
  'history.page': strictCommand('history.page', {
    providerSessionId: idStringSchema,
    cursor: optionalIdStringSchema,
    limit: optionalHistoryLimitSchema,
  }),
  'child.open': strictCommand('child.open', {
    parentAppSessionId: idStringSchema,
    childSessionId: idStringSchema,
    requestId: idStringSchema,
  }),
  'child.send': strictCommand('child.send', {
    parentAppSessionId: idStringSchema,
    childSessionId: idStringSchema,
    text: promptStringSchema,
    responseFormat: optionalResponseFormatSchema,
  }),
  'child.sendNow': strictCommand('child.sendNow', {
    parentAppSessionId: idStringSchema,
    childSessionId: idStringSchema,
    text: promptStringSchema,
    responseFormat: optionalResponseFormatSchema,
  }),
  'child.interrupt': strictCommand('child.interrupt', {
    parentAppSessionId: idStringSchema,
    childSessionId: idStringSchema,
  }),
  'child.loadHistory': strictCommand('child.loadHistory', {
    parentAppSessionId: idStringSchema,
    childSessionId: idStringSchema,
    cursor: optionalIdStringSchema,
    limit: optionalHistoryLimitSchema,
  }),
  'child.updateSettings': strictCommand('child.updateSettings', {
    parentAppSessionId: idStringSchema,
    childSessionId: idStringSchema,
    modelId: nullableModelIdSchema,
    reasoningEffort: optionalReasoningEffortSchema,
  }),
  'approval.respond': strictCommand('approval.respond', {
    appSessionId: idStringSchema,
    requestId: idStringSchema,
    outcome: permissionOutcomeSchema,
  }),
  'question.respond': strictCommand('question.respond', {
    appSessionId: idStringSchema,
    requestId: idStringSchema,
    cancelled: z.boolean(),
    answers: boundedArray(questionAnswerSchema),
  }),
} satisfies {
  [K in Extract<
    ClientCommand['type'],
    | 'catalog.models'
    | 'catalog.tools'
    | 'catalog.skills'
    | 'settings.defaults'
    | 'settings.agent.update'
    | 'settings.compaction.update'
    | 'session.create'
    | 'session.send'
    | 'session.sendNow'
    | 'session.resume'
    | 'session.interrupt'
    | 'session.updateSettings'
    | 'session.compact'
    | 'session.fork'
    | 'session.rename'
    | 'session.exportMarkdown'
    | 'sessions.reanchorCwd'
    | 'session.rewindInfo'
    | 'session.rewind'
    | 'session.close'
    | 'sessions.list'
    | 'session.loadHistory'
    | 'sessions.search'
    | 'history.indexingIdle'
    | 'history.list'
    | 'history.page'
    | 'child.open'
    | 'child.send'
    | 'child.sendNow'
    | 'child.interrupt'
    | 'child.loadHistory'
    | 'child.updateSettings'
    | 'approval.respond'
    | 'question.respond'
  >]: z.ZodType<Extract<ClientCommand, { type: K }>>;
};
