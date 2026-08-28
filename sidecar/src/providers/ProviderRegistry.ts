import {
  parseSessionConfiguration,
  providerDriverKindForInstance,
  type ProviderInstanceId,
  type SessionConfiguration,
} from './providerIdentity.js';
import { redactSensitiveText } from '../sensitiveLogRedaction.js';
import {
  assertDefinitionConsistency,
  createProviderContractError,
  parseProviderCapabilities,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderDefinition,
  type ProviderSnapshot,
} from './providerTypes.js';
import type { ShutdownDeadline } from './shutdownDeadline.js';
import { createUnavailableProviderAdapter } from './unavailableProvider.js';

export const PROVIDER_DEFINITION_ORDER = [
  'droid',
  'codex',
  'claude',
  'cursor',
  'grok',
] as const satisfies readonly ProviderInstanceId[];

export type BooleanProviderCapability = {
  [K in keyof ProviderCapabilities]: ProviderCapabilities[K] extends boolean ? K : never;
}[keyof ProviderCapabilities];

export interface ProviderRegistration {
  readonly definition: ProviderDefinition;
  readonly createAdapter: () => ProviderAdapter;
}

type ProviderRefreshState =
  | { readonly kind: 'idle'; readonly snapshot: ProviderSnapshot | undefined }
  | {
      readonly kind: 'refreshing';
      readonly snapshot: ProviderSnapshot | undefined;
      readonly generation: number;
      readonly controller: AbortController;
      readonly promise: Promise<ProviderSnapshot>;
    };

interface ProviderSlot {
  readonly definition: ProviderDefinition;
  readonly createAdapter: () => ProviderAdapter;
  adapter: ProviderAdapter | undefined;
  revision: number;
  probeGeneration: number;
  refresh: ProviderRefreshState;
}

export function builtInProviderDefinition(
  providerInstanceId: ProviderInstanceId,
): ProviderDefinition {
  const displayName = {
    droid: 'Droid',
    codex: 'Codex',
    claude: 'Claude',
    cursor: 'Cursor',
    grok: 'Grok',
  }[providerInstanceId];
  return {
    providerDriverKind: providerDriverKindForInstance(providerInstanceId),
    providerInstanceId,
    displayName,
  };
}

export function createDefaultProviderRegistry(adapters: {
  droid: () => ProviderAdapter;
  codex?: () => ProviderAdapter;
  claude?: () => ProviderAdapter;
  cursor?: () => ProviderAdapter;
  grok?: () => ProviderAdapter;
}): ProviderRegistry {
  const factories: Record<ProviderInstanceId, () => ProviderAdapter> = {
    droid: adapters.droid,
    codex: adapters.codex ?? (() => createUnavailableProviderAdapter('codex')),
    claude: adapters.claude ?? (() => createUnavailableProviderAdapter('claude')),
    cursor: adapters.cursor ?? (() => createUnavailableProviderAdapter('cursor')),
    grok: adapters.grok ?? (() => createUnavailableProviderAdapter('grok')),
  };
  return new ProviderRegistry(
    PROVIDER_DEFINITION_ORDER.map((providerInstanceId) => ({
      definition: builtInProviderDefinition(providerInstanceId),
      createAdapter: factories[providerInstanceId],
    })),
  );
}

export class ProviderRegistry {
  readonly #slots = new Map<ProviderInstanceId, ProviderSlot>();
  readonly #constructed: ProviderAdapter[] = [];
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(registrations: readonly ProviderRegistration[]) {
    const seen = new Set<ProviderInstanceId>();
    for (const registration of registrations) {
      assertDefinitionConsistency(registration.definition);
      const providerInstanceId = registration.definition.providerInstanceId;
      if (seen.has(providerInstanceId)) {
        throw createProviderContractError(
          providerInstanceId,
          'invalid_provider_configuration',
          `duplicate provider instance id ${providerInstanceId}`,
          'refresh',
        );
      }
      seen.add(providerInstanceId);
      this.#slots.set(providerInstanceId, {
        definition: registration.definition,
        createAdapter: registration.createAdapter,
        adapter: undefined,
        revision: 0,
        probeGeneration: 0,
        refresh: { kind: 'idle', snapshot: undefined },
      });
    }
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  definitions(): readonly ProviderDefinition[] {
    return PROVIDER_DEFINITION_ORDER.flatMap((providerInstanceId) => {
      const slot = this.#slots.get(providerInstanceId);
      return slot ? [slot.definition] : [];
    });
  }

  snapshot(providerInstanceId: ProviderInstanceId): ProviderSnapshot | undefined {
    return this.#slots.get(providerInstanceId)?.refresh.snapshot;
  }

  snapshots(): readonly ProviderSnapshot[] {
    return PROVIDER_DEFINITION_ORDER.flatMap((providerInstanceId) => {
      const snapshot = this.snapshot(providerInstanceId);
      return snapshot ? [snapshot] : [];
    });
  }

  resolve(providerInstanceId: ProviderInstanceId): ProviderAdapter {
    this.#assertOpen(providerInstanceId);
    return this.#ensureAdapter(this.#requireSlot(providerInstanceId));
  }

  refresh(providerInstanceId: ProviderInstanceId): Promise<ProviderSnapshot> {
    this.#assertOpen(providerInstanceId);
    const slot = this.#requireSlot(providerInstanceId);
    if (slot.refresh.kind === 'refreshing' && !slot.refresh.controller.signal.aborted) {
      return slot.refresh.promise;
    }
    return this.#startRefresh(slot);
  }

  assertCapability(
    providerInstanceId: ProviderInstanceId,
    capability: BooleanProviderCapability,
  ): void {
    const snapshot = this.#requireReadySnapshot(providerInstanceId);
    if (snapshot.capabilities[capability] !== true) {
      throw createProviderContractError(
        providerInstanceId,
        'unsupported_capability',
        `provider ${providerInstanceId} does not support ${capability}`,
        'refresh',
      );
    }
  }

  assertSelection(configuration: SessionConfiguration): ProviderSnapshot {
    const parsed = parseSessionConfiguration(configuration);
    const providerInstanceId = parsed.providerSelection.providerInstanceId;
    const snapshot = this.#requireReadySnapshot(providerInstanceId);
    if (!snapshot.capabilities.modes.includes(parsed.interactionMode)) {
      throw createProviderContractError(
        providerInstanceId,
        'unsupported_capability',
        `provider ${providerInstanceId} does not support interaction mode ${parsed.interactionMode}`,
        'refresh',
      );
    }
    if (!snapshot.capabilities.autonomyLevels.includes(parsed.autonomy)) {
      throw createProviderContractError(
        providerInstanceId,
        'unsupported_capability',
        `provider ${providerInstanceId} does not support autonomy ${parsed.autonomy}`,
        'refresh',
      );
    }
    const model = snapshot.models.find((entry) => entry.id === parsed.providerSelection.modelId);
    if (!model) {
      throw createProviderContractError(
        providerInstanceId,
        'invalid_provider_configuration',
        `provider ${providerInstanceId} does not advertise model ${parsed.providerSelection.modelId}`,
        'refresh',
      );
    }
    return snapshot;
  }

  close(deadline: ShutdownDeadline): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = this.#closeConstructedAdapters(deadline);
    return this.#closePromise;
  }

  #startRefresh(slot: ProviderSlot): Promise<ProviderSnapshot> {
    if (slot.refresh.kind === 'refreshing') {
      slot.refresh.controller.abort();
    }
    const generation = ++slot.probeGeneration;
    const controller = new AbortController();
    const promise = this.#probeAndAdopt(slot, generation, controller);
    slot.refresh = {
      kind: 'refreshing',
      snapshot: slot.refresh.snapshot,
      generation,
      controller,
      promise,
    };
    return promise;
  }

  async #probeAndAdopt(
    slot: ProviderSlot,
    generation: number,
    controller: AbortController,
  ): Promise<ProviderSnapshot> {
    try {
      const adapter = this.#ensureAdapter(slot);
      const raw = await adapter.probe(controller.signal);
      const adopted = this.#adoptProbeResult(slot, generation, controller, raw);
      if (!adopted) {
        throw createProviderContractError(
          slot.definition.providerInstanceId,
          'stale_provider_operation',
          'provider discovery refresh was cancelled',
          'refresh',
        );
      }
      return adopted;
    } catch (error) {
      this.#clearRefreshIfCurrent(slot, generation);
      throw error;
    }
  }

  #adoptProbeResult(
    slot: ProviderSlot,
    generation: number,
    controller: AbortController,
    raw: ProviderSnapshot,
  ): ProviderSnapshot | undefined {
    // Discard completions from a superseded or aborted refresh so they cannot
    // overwrite a newer snapshot.
    if (this.#closed || controller.signal.aborted || generation !== slot.probeGeneration) {
      return undefined;
    }
    if (slot.refresh.kind !== 'refreshing' || slot.refresh.generation !== generation) {
      return undefined;
    }
    const snapshot = this.#sanitizeSnapshot(slot, raw, slot.revision + 1);
    slot.revision = snapshot.revision;
    slot.refresh = { kind: 'idle', snapshot };
    return snapshot;
  }

  #sanitizeSnapshot(slot: ProviderSlot, raw: ProviderSnapshot, revision: number): ProviderSnapshot {
    assertDefinitionConsistency(raw.definition);
    if (raw.definition.providerInstanceId !== slot.definition.providerInstanceId) {
      throw createProviderContractError(
        slot.definition.providerInstanceId,
        'invalid_provider_configuration',
        `probe snapshot instance ${raw.definition.providerInstanceId} does not match ${slot.definition.providerInstanceId}`,
        'refresh',
      );
    }
    const capabilities = parseProviderCapabilities(raw.capabilities);
    const error = raw.error
      ? { ...raw.error, message: redactSensitiveText(raw.error.message) }
      : undefined;
    return {
      definition: slot.definition,
      revision,
      readiness: raw.readiness,
      executable: raw.executable
        ? {
            name: redactSensitiveText(raw.executable.name),
            version: redactSensitiveText(raw.executable.version),
          }
        : undefined,
      auth: raw.auth
        ? {
            accountLabel: raw.auth.accountLabel
              ? redactSensitiveText(raw.auth.accountLabel)
              : undefined,
            apiProviderLabel: raw.auth.apiProviderLabel
              ? redactSensitiveText(raw.auth.apiProviderLabel)
              : undefined,
            billingLabel: raw.auth.billingLabel
              ? redactSensitiveText(raw.auth.billingLabel)
              : undefined,
          }
        : undefined,
      models: raw.models.map((model) => ({
        ...model,
        id: redactSensitiveText(model.id),
        displayName: redactSensitiveText(model.displayName),
      })),
      capabilities,
      error,
    };
  }

  #requireReadySnapshot(providerInstanceId: ProviderInstanceId): ProviderSnapshot {
    const snapshot = this.snapshot(providerInstanceId);
    if (!snapshot) {
      throw createProviderContractError(
        providerInstanceId,
        'unavailable_provider_instance',
        `provider ${providerInstanceId} has no discovery snapshot`,
        'refresh',
      );
    }
    if (snapshot.readiness !== 'ready') {
      if (snapshot.error) {
        throw createProviderContractError(
          snapshot.error.providerInstanceId,
          snapshot.error.code,
          snapshot.error.message,
          snapshot.error.recoveryAction,
        );
      }
      throw createProviderContractError(
        providerInstanceId,
        'unavailable_provider_instance',
        `provider ${providerInstanceId} is not ready`,
        setupActionFor(providerInstanceId),
      );
    }
    return snapshot;
  }

  #ensureAdapter(slot: ProviderSlot): ProviderAdapter {
    if (slot.adapter) {
      return slot.adapter;
    }
    this.#assertOpen(slot.definition.providerInstanceId);
    const adapter = slot.createAdapter();
    assertDefinitionConsistency(adapter.definition);
    if (adapter.definition.providerInstanceId !== slot.definition.providerInstanceId) {
      throw createProviderContractError(
        slot.definition.providerInstanceId,
        'invalid_provider_configuration',
        `adapter instance ${adapter.definition.providerInstanceId} does not match registration ${slot.definition.providerInstanceId}`,
        'refresh',
      );
    }
    slot.adapter = adapter;
    this.#constructed.push(adapter);
    return adapter;
  }

  #requireSlot(providerInstanceId: ProviderInstanceId): ProviderSlot {
    const slot = this.#slots.get(providerInstanceId);
    if (!slot) {
      throw createProviderContractError(
        providerInstanceId,
        'unavailable_provider_instance',
        `unknown provider instance ${providerInstanceId}`,
        'refresh',
      );
    }
    return slot;
  }

  #assertOpen(providerInstanceId: ProviderInstanceId): void {
    if (this.#closed) {
      throw createProviderContractError(
        providerInstanceId,
        'stale_provider_operation',
        'provider registry is closed',
        'refresh',
      );
    }
  }

  #clearRefreshIfCurrent(slot: ProviderSlot, generation: number): void {
    if (slot.refresh.kind === 'refreshing' && slot.refresh.generation === generation) {
      slot.refresh = { kind: 'idle', snapshot: slot.refresh.snapshot };
    }
  }

  async #closeConstructedAdapters(deadline: ShutdownDeadline): Promise<void> {
    for (const slot of this.#slots.values()) {
      if (slot.refresh.kind === 'refreshing') {
        slot.probeGeneration += 1;
        slot.refresh.controller.abort();
      }
    }
    const errors: unknown[] = [];
    // Reverse construction order so later adapters cannot depend on already-closed earlier ones.
    for (const adapter of [...this.#constructed].reverse()) {
      try {
        await adapter.close(deadline);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#constructed.length = 0;
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'provider adapter close failed');
    }
  }
}

function setupActionFor(providerInstanceId: ProviderInstanceId) {
  switch (providerInstanceId) {
    case 'droid':
      return 'open_droid_setup' as const;
    case 'codex':
      return 'open_codex_setup' as const;
    case 'claude':
      return 'open_claude_setup' as const;
    case 'cursor':
      return 'open_cursor_setup' as const;
    case 'grok':
      return 'open_grok_setup' as const;
  }
}
