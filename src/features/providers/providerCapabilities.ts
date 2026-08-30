import type {
  ProviderCapabilitySnapshot,
  ProviderInstanceId,
  ProviderWireSnapshot,
  SessionInteractionMode,
} from '../../types/bridge';
import { snapshotForHarness } from './providerCatalog';

export type ControlVisibility = {
  visibility: 'show' | 'disable' | 'hide';
  reason?: string;
};

const DROID_FALLBACK_CAPABILITIES: ProviderCapabilitySnapshot = {
  modes: ['auto', 'spec', 'agi'],
  autonomyLevels: ['off', 'low', 'medium', 'high'],
  modelChange: 'before_turn',
  resume: true,
  steer: false,
  interrupt: true,
  approvals: true,
  questions: true,
  planReview: true,
  context: true,
  compaction: true,
  skills: true,
  slashCommands: true,
  mcpUse: true,
  mcpManagement: true,
  rewind: true,
  fork: true,
  observationalTasks: true,
  addressableChildren: true,
  missionControl: true,
  browser: true,
  usageReporting: true,
  reasoningStream: true,
};

const UNKNOWN_HARNESS_CAPABILITIES: ProviderCapabilitySnapshot = {
  modes: ['auto'],
  autonomyLevels: ['off', 'low', 'medium', 'high'],
  modelChange: 'before_turn',
  resume: false,
  steer: false,
  interrupt: true,
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
};

export function composerCapabilities(
  snapshots: readonly ProviderWireSnapshot[],
  providerInstanceId: ProviderInstanceId,
): ProviderCapabilitySnapshot {
  const snapshot = snapshotForHarness(snapshots, providerInstanceId);
  if (snapshot) return snapshot.capabilities;
  return providerInstanceId === 'droid'
    ? DROID_FALLBACK_CAPABILITIES
    : UNKNOWN_HARNESS_CAPABILITIES;
}

export function specControl(capabilities: ProviderCapabilitySnapshot): ControlVisibility {
  if (capabilities.modes.includes('spec')) return { visibility: 'show' };
  return { visibility: 'hide', reason: 'This harness does not support spec mode' };
}

export function supportsInteractionMode(
  capabilities: ProviderCapabilitySnapshot,
  mode: SessionInteractionMode,
): boolean {
  return capabilities.modes.includes(mode);
}

export function composerSlashVisible(
  cmd: string,
  capabilities: ProviderCapabilitySnapshot,
): boolean {
  if (cmd === '/mission') return capabilities.missionControl;
  if (cmd === '/compact') return capabilities.compaction;
  if (cmd === '/spec') return capabilities.modes.includes('spec');
  return true;
}
