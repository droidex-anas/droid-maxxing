import {
  createTerminal,
  isDesktop,
  killTerminal,
  onTerminalEvent,
  subscribeTerminal,
  unsubscribeTerminal,
  writeTerminal,
} from '../../lib/desktop';
import type { PluginDefinition, PluginMarketplace } from './pluginCatalog';

const PLUGIN_MANAGER_SESSION_ID = '__droidex_plugin_manager__';
const DONE_MARKER = '__DROIDEX_PLUGIN_DONE__';
const OPERATION_TIMEOUT_MS = 2 * 60 * 1000;

export interface PluginCommandResult {
  ok: boolean;
  output: string;
  message: string;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function marketplacePreparation(marketplace: PluginMarketplace): string {
  const source = shellQuote(marketplace.sourceUrl);
  const name = shellQuote(marketplace.cliName);
  return [
    `droid plugin marketplace add ${source} >/dev/null 2>&1`,
    `droid plugin marketplace update ${name} >/dev/null 2>&1`,
    'true',
  ].join(' || ');
}

export function buildInstallCommand(
  plugin: PluginDefinition,
  marketplace?: PluginMarketplace,
): string {
  if (!plugin.installId) throw new Error(`${plugin.name} does not expose a Droid install package.`);
  const install = `droid plugin install ${shellQuote(plugin.installId)} --scope user`;
  return marketplace ? `(${marketplacePreparation(marketplace)}) && ${install}` : install;
}

export function buildUpdateCommand(
  plugin: PluginDefinition,
  marketplace?: PluginMarketplace,
): string {
  if (!plugin.installId) throw new Error(`${plugin.name} does not expose a Droid install package.`);
  const update = `droid plugin update ${shellQuote(plugin.installId)} --scope user`;
  return marketplace
    ? `droid plugin marketplace update ${shellQuote(marketplace.cliName)} >/dev/null 2>&1 || true; ${update}`
    : update;
}

export function buildUninstallCommand(installId: string): string {
  return `droid plugin uninstall ${shellQuote(installId)} --scope user`;
}

export function buildAddMarketplaceCommand(marketplace: PluginMarketplace): string {
  return `droid plugin marketplace add ${shellQuote(marketplace.sourceUrl)}`;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .replace(/\u0008/g, '');
}

function resultMessage(output: string, ok: boolean): string {
  const useful = stripAnsi(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.includes(DONE_MARKER) &&
        !line.startsWith('droid plugin '),
    )
    .slice(-4)
    .join(' ');
  if (useful) return useful;
  return ok ? 'Plugin operation completed.' : 'Droid could not complete this plugin operation.';
}

function supportsShellOperations(): boolean {
  if (typeof navigator === 'undefined') return false;
  return !/Windows/i.test(navigator.userAgent);
}

export async function runPluginCommand(command: string): Promise<PluginCommandResult> {
  if (!isDesktop()) throw new Error('Plugin management is available in the DROIDEX desktop app.');
  if (!supportsShellOperations()) {
    throw new Error('One-click plugin management currently requires macOS or Linux.');
  }

  const terminal = await createTerminal({
    appSessionId: PLUGIN_MANAGER_SESSION_ID,
    cwd: '',
    cols: 120,
    rows: 30,
  });

  return new Promise<PluginCommandResult>((resolve, reject) => {
    let output = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopListening: () => void = () => undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      stopListening();
      void unsubscribeTerminal(terminal.id).catch(() => undefined);
      void killTerminal(terminal.id).catch(() => undefined);
    };

    const finish = (result: PluginCommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    stopListening = onTerminalEvent((event) => {
      if (event.terminalId !== terminal.id) return;
      if (event.kind === 'data' || event.kind === 'replay') {
        output += event.data;
        const normalized = stripAnsi(output);
        const match = new RegExp(`${DONE_MARKER}:(\\d+)`).exec(normalized);
        if (!match) return;
        const ok = Number(match[1]) === 0;
        finish({ ok, output: normalized, message: resultMessage(normalized, ok) });
        return;
      }
      if (event.kind === 'exit') {
        const normalized = stripAnsi(output);
        const ok = event.exitCode === 0;
        finish({ ok, output: normalized, message: resultMessage(normalized, ok) });
      }
    });

    timeout = setTimeout(() => {
      fail(new Error('Plugin operation timed out. Check your network connection and Droid login.'));
    }, OPERATION_TIMEOUT_MS);

    void subscribeTerminal(terminal.id)
      .then(() => {
        const wrapped = `${command}; __droidex_status=$?; printf '\\n${DONE_MARKER}:%s\\n' "$__droidex_status"`;
        return writeTerminal(terminal.id, `${wrapped}\r`);
      })
      .catch(fail);
  });
}
