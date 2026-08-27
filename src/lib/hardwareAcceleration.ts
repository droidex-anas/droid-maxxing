import { relaunchApp } from './onboarding';

interface HardwareAccelerationPreference {
  enabled: boolean;
}

export async function getHardwareAcceleration(): Promise<HardwareAccelerationPreference> {
  return normalizePreference(await invokeHardwareAccelerationBridge('getHardwareAcceleration'));
}

export async function setHardwareAcceleration(
  enabled: boolean,
): Promise<HardwareAccelerationPreference> {
  return normalizePreference(
    await invokeHardwareAccelerationBridge('setHardwareAcceleration', [enabled]),
  );
}

export async function restartForHardwareAcceleration(): Promise<void> {
  await relaunchApp();
}

function invokeHardwareAccelerationBridge(name: string, args: unknown[] = []): Promise<unknown> {
  const bridge = window.droidControl;
  if (!bridge) return Promise.resolve({ enabled: true });
  const method: unknown = Reflect.get(bridge, name);
  if (typeof method !== 'function') return Promise.resolve({ enabled: true });
  return Promise.resolve(Reflect.apply(method, bridge, args));
}

function normalizePreference(value: unknown): HardwareAccelerationPreference {
  if (!value || typeof value !== 'object' || !('enabled' in value)) {
    throw new Error('Hardware acceleration preference response is invalid.');
  }
  const enabled = Reflect.get(value, 'enabled');
  if (typeof enabled !== 'boolean') {
    throw new Error('Hardware acceleration preference response is invalid.');
  }
  return { enabled };
}
