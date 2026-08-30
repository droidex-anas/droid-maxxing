import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('../../sidecar/node_modules/ws') as {
  WebSocketServer: new (options: { server: ReturnType<typeof createServer> }) => {
    on(event: 'connection', listener: (socket: MockSocket) => void): void;
    close(): void;
  };
};

type MockSocket = {
  on(event: 'message', listener: (data: Buffer) => void): void;
  send(data: string): void;
};

const ARTIFACTS = '/opt/cursor/artifacts';
const GROK_CAPS = {
  modes: ['auto'],
  autonomyLevels: ['off', 'low', 'medium', 'high'],
};
const DROID_CAPS = {
  modes: ['auto', 'spec', 'agi'],
  autonomyLevels: ['off', 'low', 'medium', 'high'],
  missionControl: true,
  compaction: true,
  reasoningStream: true,
};

function snapshots() {
  return [
    {
      definition: {
        providerDriverKind: 'droid',
        providerInstanceId: 'droid',
        displayName: 'Droid',
      },
      revision: 1,
      readiness: 'ready',
      models: [
        {
          id: 'droid-core',
          displayName: 'Droid Core',
          isDefault: true,
          supportedReasoningEfforts: ['low', 'high'],
        },
      ],
      capabilities: DROID_CAPS,
    },
    {
      definition: {
        providerDriverKind: 'codex',
        providerInstanceId: 'codex',
        displayName: 'Codex',
      },
      revision: 1,
      readiness: 'unavailable',
      models: [],
      capabilities: GROK_CAPS,
      error: {
        code: 'unavailable_provider_instance',
        message: 'Codex has no discovery snapshot.',
        recoveryAction: 'refresh',
      },
    },
    {
      definition: {
        providerDriverKind: 'claude',
        providerInstanceId: 'claude',
        displayName: 'Claude',
      },
      revision: 1,
      readiness: 'unavailable',
      models: [],
      capabilities: GROK_CAPS,
      error: {
        code: 'unavailable_provider_instance',
        message: 'Claude has no discovery snapshot.',
        recoveryAction: 'refresh',
      },
    },
    {
      definition: {
        providerDriverKind: 'cursor',
        providerInstanceId: 'cursor',
        displayName: 'Cursor',
      },
      revision: 1,
      readiness: 'unauthenticated',
      models: [
        {
          id: 'cursor-auto',
          displayName: 'Cursor Auto',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
        },
      ],
      capabilities: { ...GROK_CAPS, modes: ['auto'] },
    },
    {
      definition: { providerDriverKind: 'grok', providerInstanceId: 'grok', displayName: 'Grok' },
      revision: 1,
      readiness: 'ready',
      models: [
        {
          id: 'grok-build',
          displayName: 'Grok Build',
          isDefault: true,
          supportedReasoningEfforts: [],
        },
      ],
      capabilities: GROK_CAPS,
    },
  ];
}

function startMockBridge(): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (socket) => {
      let seq = 0;
      const emit = (event: Record<string, unknown>) => {
        seq += 1;
        socket.send(
          JSON.stringify({
            type: 'events.batch',
            generation: 'harness-picker',
            firstSeq: seq,
            lastSeq: seq,
            events: [{ seq, event }],
          }),
        );
      };
      const now = Date.now();
      const session = (
        appSessionId: string,
        title: string,
        providerInstanceId: 'droid' | 'grok',
        modelId: string,
      ) => ({
        appSessionId,
        sessionPurpose: 'chat',
        role: 'primary',
        title,
        goal: title,
        cwd: '',
        configuration: {
          providerSelection: { providerInstanceId, modelId, options: {} },
          interactionMode: 'auto',
          autonomy: 'off',
        },
        phase: 'completed',
        features: [],
        tokensIn: 0,
        tokensOut: 0,
        contextTokens: 0,
        createdAt: now,
        updatedAt: now,
      });
      emit({ type: 'connection', status: 'connected' });
      emit({ type: 'providers.updated', snapshots: snapshots() });
      emit({
        type: 'catalog.updated',
        catalog: 'models',
        items: [
          {
            id: 'droid-core',
            displayName: 'Droid Core',
            provider: 'factory',
            isCustom: false,
            supportedReasoningEfforts: ['low', 'high'],
            defaultReasoningEffort: 'high',
          },
        ],
      });
      emit({
        type: 'session.created',
        clientRef: 'seed-droid',
        session: session('sess-droid', 'Droid chat', 'droid', 'droid-core'),
      });
      emit({
        type: 'session.created',
        clientRef: 'seed-grok',
        session: session('sess-grok', 'Grok chat', 'grok', 'grok-build'),
      });
      socket.on('message', (data) => {
        let command: {
          type?: string;
          clientRef?: string;
          title?: string;
          goal?: string;
          cwd?: string;
          configuration?: unknown;
        };
        try {
          command = JSON.parse(String(data)) as typeof command;
        } catch {
          return;
        }
        if (command.type === 'catalog.models' || command.type === 'providers.refresh') {
          emit({ type: 'providers.updated', snapshots: snapshots() });
          return;
        }
        if (command.type === 'session.create' && command.clientRef) {
          emit({
            type: 'session.created',
            clientRef: command.clientRef,
            session: {
              appSessionId: `sess-${command.clientRef}`,
              sessionPurpose: 'chat',
              role: 'primary',
              title: command.title ?? 'Chat',
              goal: command.goal ?? '',
              cwd: command.cwd ?? '',
              configuration: command.configuration ?? {
                providerSelection: {
                  providerInstanceId: 'grok',
                  modelId: 'grok-build',
                  options: {},
                },
                interactionMode: 'auto',
                autonomy: 'off',
              },
              phase: 'completed',
              features: [],
              tokensIn: 0,
              tokensOut: 0,
              contextTokens: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          });
        }
      });
    });
    httpServer.once('error', reject);
    httpServer.listen(8765, '127.0.0.1', () => {
      resolve({
        close: () =>
          new Promise((done) => {
            wss.close();
            httpServer.close(() => {
              done();
            });
          }),
      });
    });
  });
}

test.use({
  channel: 'chrome',
  viewport: { width: 1440, height: 900 },
});

test.describe.configure({ mode: 'serial' });

let mock: { close: () => Promise<void> };

test.beforeAll(async () => {
  mock = await startMockBridge();
});

test.afterAll(async () => {
  await mock.close();
});

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: `${ARTIFACTS}/${name}.png`, fullPage: true });
}

async function openPicker(page: Page): Promise<void> {
  await page.getByTitle('Select chat model').click();
  await expect(page.getByTestId('harness-strip')).toBeVisible();
}

test('the model picker lists harnesses, Grok models, then locks on a live session', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('textarea').first()).toBeVisible();
  await expect(page.getByTitle('Select chat model')).toBeVisible();
  const grokRow = page.locator('[data-testid="session-row"][data-app-session-id="sess-grok"]');
  const droidRow = page.locator('[data-testid="session-row"][data-app-session-id="sess-droid"]');
  await expect(grokRow).toBeVisible();
  await expect(droidRow).toBeVisible();
  await expect(grokRow.getByTestId('harness-icon')).toHaveAttribute('data-harness', 'grok');
  await expect(droidRow.getByTestId('harness-icon')).toHaveAttribute('data-harness', 'droid');
  await shot(page, 'composer_draft_with_harness_sidebar');

  await openPicker(page);
  for (const id of ['droid', 'codex', 'claude', 'cursor', 'grok']) {
    await expect(
      page.locator(`[data-testid="harness-option"][data-harness="${id}"]`),
    ).toBeVisible();
  }
  await expect(
    page.locator('[data-testid="harness-option"][data-harness="droid"]'),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^(Chat|Spec)$/ })).toBeVisible();
  await expect(page.getByText('Use Factory CLI default')).toBeVisible();
  await expect(page.getByText('Reasoning', { exact: true })).toBeVisible();
  await shot(page, 'model_picker_droid_harness_strip');

  await page.locator('[data-testid="harness-option"][data-harness="grok"]').click();
  await expect(page.locator('[data-testid="harness-option"][data-harness="grok"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Grok Build Grok' })).toBeVisible();
  await expect(page.getByTitle('Select chat model')).toContainText('Grok Build');
  await expect(page.getByText('Droid Core')).toHaveCount(0);
  await expect(page.getByText('Use Factory CLI default')).toHaveCount(0);
  await expect(page.getByText('Reasoning', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Chat|Spec)$/ })).toHaveCount(0);
  await shot(page, 'model_picker_grok_catalog');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('harness-strip')).toHaveCount(0);
  await expect(page.getByTitle('Select chat model')).toContainText('Grok Build');
  await shot(page, 'composer_grok_selected_sidebar_icons');

  await grokRow.click();
  await expect(grokRow).toHaveAttribute('aria-current', 'true');
  await openPicker(page);
  await expect(page.locator('[data-testid="harness-option"][data-harness="droid"]')).toBeDisabled();
  await expect(page.locator('[data-testid="harness-option"][data-harness="grok"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.locator('[data-testid="harness-option"][data-harness="droid"]'),
  ).toHaveAttribute('title', 'Harness is locked after the first prompt');
  await shot(page, 'model_picker_grok_locked');
});
