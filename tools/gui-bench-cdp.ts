export interface CdpRemoteObject {
  type?: string;
  value?: unknown;
  objectId?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string; data?: unknown };
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message ?? 'CDP command failed.'));
        return;
      }
      waiter.resolve(message.result ?? {});
    });
  }

  static async connect(webSocketDebuggerUrl: string): Promise<CdpClient> {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open.')), {
        once: true,
      });
    });
    const client = new CdpClient(socket);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Input.setIgnoreInputEvents', { ignore: false });
    return client;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const remote = result.result as CdpRemoteObject | undefined;
    const exception = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    if (exception) {
      throw new Error(exception.exception?.description ?? exception.text ?? 'Runtime.evaluate threw.');
    }
    return remote?.value as T;
  }

  async capturePng(): Promise<Buffer> {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    const data = result.data;
    if (typeof data !== 'string') throw new Error('Page.captureScreenshot returned no data.');
    return Buffer.from(data, 'base64');
  }

  async dispatchWheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
      pointerType: 'mouse',
    });
  }

  async dispatchEnter(): Promise<void> {
    const key = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r',
    };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  close(): void {
    this.socket.close();
    for (const waiter of this.pending.values()) waiter.reject(new Error('CDP client closed.'));
    this.pending.clear();
  }
}

export async function waitForCdpTarget(
  port: number,
  timeoutMs = 30_000,
): Promise<{ webSocketDebuggerUrl: string; title: string; url: string }> {
  const startedAt = Date.now();
  let lastError = 'no target yet';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
      const targets = (await response.json()) as Array<{
        type?: string;
        title?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = targets.find(
        (target) =>
          target.type === 'page' &&
          typeof target.webSocketDebuggerUrl === 'string' &&
          (target.url?.includes('index.html') === true ||
            target.title?.toLowerCase().includes('droid') === true ||
            target.url?.startsWith('file:') === true),
      );
      const fallback = targets.find(
        (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
      );
      const chosen = page ?? fallback;
      if (chosen?.webSocketDebuggerUrl) {
        return {
          webSocketDebuggerUrl: chosen.webSocketDebuggerUrl,
          title: chosen.title ?? '',
          url: chosen.url ?? '',
        };
      }
      lastError = `targets=${JSON.stringify(targets.map((target) => ({ type: target.type, title: target.title, url: target.url })))}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for CDP page on port ${String(port)} (${lastError}).`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
