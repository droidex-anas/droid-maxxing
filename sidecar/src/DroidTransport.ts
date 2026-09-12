import {
  ProcessTransport,
  type DroidClientTransport,
  type ProcessTransportOptions,
} from '@factory/droid-sdk';
import type { ChildProcess } from 'node:child_process';

const PERMISSION_OPTION_ALIASES: Record<string, string> = {
  proceed_always_file: 'proceed_always',
  proceed_always_server: 'proceed_always',
  proceed_always_tools: 'proceed_always',
};

export type ConnectableDroidTransport = DroidClientTransport & {
  connect(): Promise<void>;
  readonly processId: number | undefined;
};

export function createDroidTransport(options: ProcessTransportOptions): ConnectableDroidTransport {
  return wrapDroidTransport(new ProcessTransport(options));
}

export function wrapDroidTransport(inner: DroidClientTransport): ConnectableDroidTransport {
  return new PermissionNormalizingTransport(inner);
}

export function normalizeDroidTransportMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const method = message.method;
  if (method !== 'droid.request_permission' && method !== 'daemon.request_permission')
    return message;

  const params = message.params;
  if (!isRecord(params) || !Array.isArray(params.options)) return message;

  let changed = false;
  const options = params.options.map((option: unknown) => {
    if (!isRecord(option)) return option;
    const normalized = normalizePermissionOption(option.value);
    if (normalized === option.value) return option;
    changed = true;
    return { ...option, value: normalized };
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TS can't see the mutation inside the .map() closure above.
  if (!changed) return message;
  return { ...message, params: { ...params, options } };
}

function normalizePermissionOption(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return PERMISSION_OPTION_ALIASES[value] ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

class PermissionNormalizingTransport implements ConnectableDroidTransport {
  private childProcess: ChildProcess | undefined;

  constructor(private readonly inner: DroidClientTransport) {}

  get isConnected(): boolean {
    return this.inner.isConnected;
  }

  // The SDK clears its reference before close finishes; retain the actual
  // child so a failed close cannot erase its still-live process identity.
  get processId(): number | undefined {
    this.childProcess ??=
      (this.inner as { childProcess?: ChildProcess | null }).childProcess ?? undefined;
    const child = this.childProcess;
    return child?.exitCode === null && child.signalCode === null ? child.pid : undefined;
  }

  connect(): Promise<void> {
    this.childProcess = undefined;
    return this.inner.connect?.() ?? Promise.resolve();
  }

  send(message: Record<string, unknown>): void {
    this.inner.send(message);
  }

  onMessage(callback: (message: Record<string, unknown>) => void): void {
    this.inner.onMessage((message) => {
      callback(normalizeDroidTransportMessage(message));
    });
  }

  onError(callback: (error: Error) => void): void {
    this.inner.onError(callback);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
