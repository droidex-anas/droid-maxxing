import { providerDriverKindForInstance, type ProviderInstanceId } from './providerIdentity.js';
import type { ProviderRecoveryAction } from './providerErrors.js';
import {
  createProviderContractError,
  defineProviderCapabilities,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderDefinition,
  type ProviderSessionCreateInput,
  type ProviderSessionResumeInput,
  type ProviderSnapshot,
} from './providerTypes.js';
import type { ShutdownDeadline } from './shutdownDeadline.js';

export type UnavailableProviderInstanceId = Exclude<ProviderInstanceId, 'droid'>;

export const UNAVAILABLE_PROVIDER_CAPABILITIES: ProviderCapabilities = defineProviderCapabilities({
  modes: [],
  autonomyLevels: [],
  modelChange: 'unsupported',
  resume: false,
  steer: false,
  interrupt: false,
  approvals: false,
  questions: false,
  planReview: false,
  context: false,
  compaction: false,
  skills: false,
  slashCommands: false,
  mcpUse: false,
  mcpManagement: false,
  rewind: false,
  fork: false,
  observationalTasks: false,
  addressableChildren: false,
  missionControl: false,
  browser: false,
  usageReporting: false,
  reasoningStream: false,
});

const DISPLAY_NAME: Record<UnavailableProviderInstanceId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  grok: 'Grok',
};

const SETUP_ACTION: Record<UnavailableProviderInstanceId, ProviderRecoveryAction> = {
  codex: 'open_codex_setup',
  claude: 'open_claude_setup',
  cursor: 'open_cursor_setup',
  grok: 'open_grok_setup',
};

export function unavailableProviderDefinition(
  providerInstanceId: UnavailableProviderInstanceId,
): ProviderDefinition {
  return {
    providerDriverKind: providerDriverKindForInstance(providerInstanceId),
    providerInstanceId,
    displayName: DISPLAY_NAME[providerInstanceId],
  };
}

export function createUnavailableProviderAdapter(
  providerInstanceId: UnavailableProviderInstanceId,
): ProviderAdapter {
  return new UnavailableProviderAdapter(providerInstanceId);
}

class UnavailableProviderAdapter implements ProviderAdapter {
  readonly definition: ProviderDefinition;

  constructor(private readonly providerInstanceId: UnavailableProviderInstanceId) {
    this.definition = unavailableProviderDefinition(providerInstanceId);
  }

  async probe(signal: AbortSignal): Promise<ProviderSnapshot> {
    if (signal.aborted) {
      throw createProviderContractError(
        this.providerInstanceId,
        'stale_provider_operation',
        `${this.definition.displayName} discovery was cancelled`,
        'refresh',
      );
    }
    return this.#snapshot();
  }

  async create(_input: ProviderSessionCreateInput): Promise<never> {
    throw this.#unavailable();
  }

  async resume(_input: ProviderSessionResumeInput): Promise<never> {
    throw this.#unavailable();
  }

  async close(_deadline: ShutdownDeadline): Promise<void> {}

  #snapshot(): ProviderSnapshot {
    const error = this.#unavailable().toProviderError();
    return {
      definition: this.definition,
      revision: 0,
      readiness: 'missing',
      models: [],
      capabilities: UNAVAILABLE_PROVIDER_CAPABILITIES,
      error,
    };
  }

  #unavailable() {
    const displayName = this.definition.displayName;
    return createProviderContractError(
      this.providerInstanceId,
      'unavailable_provider_instance',
      `${displayName} is not available yet. Open ${displayName} setup to install and authenticate it.`,
      SETUP_ACTION[this.providerInstanceId],
    );
  }
}
