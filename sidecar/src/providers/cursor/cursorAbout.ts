// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/Layers/CursorProvider.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import { resolveAcpExecutable, wrapAcpInvocation } from '../acp/acpProcess.js';
import { createProviderContractError } from '../providerTypes.js';
import { CURSOR_ABOUT_TIMEOUT_MS } from './cursorHandshake.js';

const execFileAsync = promisify(execFile);

export type CursorAuthStatus = 'authenticated' | 'unauthenticated' | 'unknown';

export interface CursorAboutAuth {
  status: CursorAuthStatus;
  email?: string;
  billingLabel?: string;
}

export interface CursorAboutParse {
  version: string | null;
  auth: CursorAboutAuth;
  message?: string;
}

export interface CursorCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export type CursorCommandRunner = (input: {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<CursorCommandResult>;

const aboutJsonSchema = z
  .object({
    cliVersion: z.unknown().optional(),
    subscriptionTier: z.unknown().optional(),
    userEmail: z.unknown().optional(),
  })
  .passthrough();

export const CURSOR_UNAUTHENTICATED_MESSAGE =
  'Cursor Agent is not authenticated. Run `agent login` and try again.';

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, '');
}

export function isCursorAboutJsonFormatUnsupported(result: CursorCommandResult): boolean {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    lowerOutput.includes("unknown option '--format'") ||
    lowerOutput.includes("unexpected argument '--format'") ||
    lowerOutput.includes("unrecognized option '--format'") ||
    lowerOutput.includes("unknown argument '--format'")
  );
}

export function parseCursorAboutOutput(result: CursorCommandResult): CursorAboutParse {
  const jsonPayload = parseCursorAboutJsonPayload(result.stdout);
  if (jsonPayload) {
    return parseJsonAbout(jsonPayload, result.code);
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = combined.toLowerCase();
  if (
    lowerOutput.includes('unknown command') ||
    lowerOutput.includes('unrecognized command') ||
    lowerOutput.includes('unexpected argument')
  ) {
    return {
      version: null,
      auth: { status: 'unknown' },
      message: 'The Cursor Agent `about` command is unavailable in this version.',
    };
  }

  const plain = stripAnsi(combined);
  const version = extractAboutField(plain, 'CLI Version') ?? null;
  const userEmail = extractAboutField(plain, 'User Email');
  if (userEmail === undefined) {
    if (result.code === 0) {
      return { version, auth: { status: 'unknown' } };
    }
    return {
      version,
      auth: { status: 'unknown' },
      message: 'Could not verify Cursor Agent authentication status.',
    };
  }
  return parseEmailAuth(version, userEmail);
}

export async function defaultCursorCommandRunner(input: {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<CursorCommandResult> {
  const resolved = resolveAcpExecutable(input.command);
  if (resolved === undefined) {
    throw createProviderContractError(
      'cursor',
      'missing_executable',
      'Cursor Agent executable was not found.',
      'open_cursor_setup',
    );
  }
  const invocation = wrapAcpInvocation(resolved, [...input.args]);
  try {
    const result = await execFileAsync(invocation.execPath, invocation.execArgs, {
      timeout: input.timeoutMs,
      signal: input.signal,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: 0,
      timedOut: false,
    };
  } catch (error) {
    return mapExecFailure(error);
  }
}

export async function runCursorAbout(input: {
  command: string;
  runCommand: CursorCommandRunner;
  timeoutMs?: number;
  signal: AbortSignal;
}): Promise<CursorCommandResult> {
  const timeoutMs = input.timeoutMs ?? CURSOR_ABOUT_TIMEOUT_MS;
  const jsonResult = await input.runCommand({
    command: input.command,
    args: ['about', '--format', 'json'],
    timeoutMs,
    signal: input.signal,
  });
  if (!isCursorAboutJsonFormatUnsupported(jsonResult)) {
    return jsonResult;
  }
  return input.runCommand({
    command: input.command,
    args: ['about'],
    timeoutMs,
    signal: input.signal,
  });
}

function parseCursorAboutJsonPayload(raw: string): z.infer<typeof aboutJsonSchema> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const result = aboutJsonSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonAbout(payload: z.infer<typeof aboutJsonSchema>, code: number): CursorAboutParse {
  const version = typeof payload.cliVersion === 'string' ? payload.cliVersion.trim() : null;
  const hasUserEmailField = Object.prototype.hasOwnProperty.call(payload, 'userEmail');
  const userEmail = typeof payload.userEmail === 'string' ? payload.userEmail.trim() : undefined;
  const subscriptionType =
    typeof payload.subscriptionTier === 'string' ? payload.subscriptionTier.trim() : undefined;
  const billingLabel = cursorSubscriptionLabel(subscriptionType);

  if (hasUserEmailField && payload.userEmail == null) {
    return {
      version,
      auth: { status: 'unauthenticated' },
      message: CURSOR_UNAUTHENTICATED_MESSAGE,
    };
  }

  if (!userEmail) {
    if (code === 0) {
      return {
        version,
        auth: {
          status: 'unknown',
          ...(billingLabel ? { billingLabel } : {}),
        },
      };
    }
    return {
      version,
      auth: { status: 'unknown' },
      message: 'Could not verify Cursor Agent authentication status.',
    };
  }

  return parseEmailAuth(version, userEmail, billingLabel);
}

function parseEmailAuth(
  version: string | null,
  userEmail: string,
  billingLabel?: string,
): CursorAboutParse {
  const lowerEmail = userEmail.toLowerCase();
  if (
    lowerEmail === 'not logged in' ||
    lowerEmail.includes('login required') ||
    lowerEmail.includes('authentication required')
  ) {
    return {
      version,
      auth: { status: 'unauthenticated' },
      message: CURSOR_UNAUTHENTICATED_MESSAGE,
    };
  }
  return {
    version,
    auth: {
      status: 'authenticated',
      email: userEmail,
      ...(billingLabel ? { billingLabel } : {}),
    },
  };
}

function cursorSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, '');
  if (!normalized || !subscriptionType) {
    return undefined;
  }
  switch (normalized) {
    case 'team':
      return 'Cursor Team';
    case 'pro':
      return 'Cursor Pro';
    case 'free':
      return 'Cursor Free';
    case 'business':
      return 'Cursor Business';
    case 'enterprise':
      return 'Cursor Enterprise';
    default:
      return `Cursor ${toTitleCaseWords(subscriptionType)}`;
  }
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, 'mi');
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

function mapExecFailure(error: unknown): CursorCommandResult {
  if (isErrnoException(error) && error.code === 'ENOENT') {
    throw createProviderContractError(
      'cursor',
      'missing_executable',
      'Cursor Agent executable was not found.',
      'open_cursor_setup',
    );
  }
  if (isErrnoException(error) && error.code === 'ABORT_ERR') {
    throw createProviderContractError(
      'cursor',
      'stale_provider_operation',
      'Cursor discovery was cancelled.',
      'refresh',
    );
  }
  const timedOut =
    isErrnoException(error) && (error.killed === true || error.code === 'ERR_TIMEOUT');
  if (timedOut) {
    return { stdout: '', stderr: '', code: 1, timedOut: true };
  }
  const stdout = isErrnoException(error) && errorHasText(error, 'stdout') ? error.stdout : '';
  const stderr = isErrnoException(error) && errorHasText(error, 'stderr') ? error.stderr : '';
  const code = isErrnoException(error) && errorHasNumber(error, 'code') ? error.code : 1;
  return { stdout, stderr, code, timedOut: false };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException & {
  killed?: boolean;
  stdout?: string;
  stderr?: string;
} {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorHasText(
  error: object,
  key: 'stdout' | 'stderr',
): error is { stdout: string; stderr: string } {
  return typeof Reflect.get(error, key) === 'string';
}

function errorHasNumber(error: object, key: 'code'): error is { code: number } {
  return typeof Reflect.get(error, key) === 'number';
}
