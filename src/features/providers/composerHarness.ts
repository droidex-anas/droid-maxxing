import type {
  ModelInfo,
  ProviderInstanceId,
  ProviderWireSnapshot,
  SessionSummary,
} from '../../types/bridge';
import { composerCapabilities, specControl } from './providerCapabilities';
import { activeHarnessId, modelsForHarness } from './providerCatalog';

export function resolveComposerHarness(input: {
  activeSession?: Pick<SessionSummary, 'configuration'> | null;
  draftProviderInstanceId: ProviderInstanceId;
  providerSnapshots: readonly ProviderWireSnapshot[];
  droidModels: readonly ModelInfo[];
}) {
  const harnessId = activeHarnessId(input);
  const capabilities = composerCapabilities(input.providerSnapshots, harnessId);
  return {
    harnessId,
    capabilities,
    catalog: modelsForHarness({
      harnessId,
      droidModels: input.droidModels,
      snapshots: input.providerSnapshots,
    }),
    specAllowed: specControl(capabilities).visibility !== 'hide',
  };
}
