import { expect, test } from '@playwright/test';
import type { ClientCommand, TranscriptEvent } from '../../src/types/bridge';

test('auto-reload accepts local query/fragment URLs without accepting lookalike hosts', async ({
  page,
}) => {
  await page.routeWebSocket(/.*/, (socket) => socket.close());
  await page.goto('/');
  await page.clock.install();
  const commands: ClientCommand[] = [];
  await page.exposeFunction('recordReloadCommand', (command: ClientCommand) =>
    commands.push(command),
  );
  await page.evaluate(async () => {
    const [
      { default: React },
      { default: ReactDOMClient },
      { default: ReactDOM },
      store,
      { bridge },
      { useBrowserAutoReload },
    ] = await Promise.all(
      [
        '/node_modules/.vite/deps/react.js',
        '/node_modules/.vite/deps/react-dom_client.js',
        '/node_modules/.vite/deps/react-dom.js',
        '/src/hooks/useStore.tsx',
        '/src/lib/bridge.ts',
        '/src/components/browser/useBrowserAutoReload.ts',
      ].map((path) => import(/* @vite-ignore */ path)),
    );
    bridge.send = Reflect.get(window, 'recordReloadCommand');
    const root = ReactDOMClient.createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    let state = store.initialState;
    function ReloadProbe({ url }: { url: string }) {
      useBrowserAutoReload('browser-test', url, 'chat-test');
      return null;
    }
    Reflect.set(window, 'renderReloadProbe', (url: string, events: TranscriptEvent[]) => {
      state = store.reducer(state, {
        type: 'BATCH',
        actions: events.map((event) => ({ type: 'SESSION_TRANSCRIPT', event })),
      });
      ReactDOM.flushSync(() =>
        root.render(
          React.createElement(
            store.StaticStoreProvider,
            { state, dispatch: () => undefined },
            React.createElement(ReloadProbe, { url }),
          ),
        ),
      );
    });
  });
  for (const [url, eligible] of [
    ['http://localhost:3000?view=editor', true],
    ['http://127.0.0.1#preview', true],
    ['https://[::1]:4173#preview', true],
    ['http://0.0.0.0?view=editor', true],
    ['http://localhost:3000/path', true],
    ['http://localhost.example?view=editor', false],
    ['http://127.0.0.1.example#preview', false],
    ['http://localhost:3000@evil.example#preview', false],
  ] as const) {
    await page.evaluate((url) => Reflect.get(window, 'renderReloadProbe')(url, []), url);
    await page.clock.runFor(1);
    const before = commands.filter((command) => command.type === 'browser.reload').length;
    await page.evaluate((url) => {
      const events = ['tool_call', 'tool_result'].map((kind) => ({
        id: `${url}-${kind}`,
        appSessionId: 'chat-test',
        sourceSessionId: 'primary',
        role: 'primary',
        ts: Date.now(),
        kind,
        toolUseId: url,
        toolName: kind === 'tool_call' ? 'Edit' : undefined,
      }));
      Reflect.get(window, 'renderReloadProbe')(url, events);
    }, url);
    await page.clock.runFor(601);
    const reloads = commands.filter((command) => command.type === 'browser.reload');
    expect(reloads.length, url).toBe(before + Number(eligible));
    if (eligible)
      expect(reloads.at(-1)).toEqual({ type: 'browser.reload', appSessionId: 'browser-test' });
  }
});
