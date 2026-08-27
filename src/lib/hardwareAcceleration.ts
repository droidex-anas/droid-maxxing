import { relaunchApp } from './onboarding';

interface HardwareAccelerationPreference {
  enabled: boolean;
}

export function isHardwareAccelerationSettingAvailable(): boolean {
  return hardwareAccelerationBridge() !== null;
}

export async function getHardwareAcceleration(): Promise<HardwareAccelerationPreference> {
  const bridge = requireHardwareAccelerationBridge();
  const value = await bridge.getHardwareAcceleration();
  return readHardwareAccelerationPreference(value);
}

export async function setHardwareAcceleration(
  enabled: boolean,
): Promise<HardwareAccelerationPreference> {
  const bridge = requireHardwareAccelerationBridge();
  const value = await bridge.setHardwareAcceleration(enabled);
  return readHardwareAccelerationPreference(value);
}

export async function restartForHardwareAcceleration(): Promise<void> {
  await relaunchApp();
}

function hardwareAccelerationBridge() {
  if (typeof window === 'undefined') return null;
  const bridge = window.droidControl;
  if (
    !bridge ||
    typeof bridge.getHardwareAcceleration !== 'function' ||
    typeof bridge.setHardwareAcceleration !== 'function'
  ) {
    return null;
  }
  return bridge;
}

function requireHardwareAccelerationBridge() {
  const bridge = hardwareAccelerationBridge();
  if (!bridge) {
    throw new Error('Hardware acceleration settings are only available in the DROIDEX app.');
  }
  return bridge;
}

function readHardwareAccelerationPreference(value: unknown): HardwareAccelerationPreference {
  if (!value || typeof value !== 'object' || !('enabled' in value)) {
    throw new Error('Hardware acceleration preference response is invalid.');
  }
  const enabled = Reflect.get(value, 'enabled');
  if (typeof enabled !== 'boolean') {
    throw new Error('Hardware acceleration preference response is invalid.');
  }
  return { enabled };
}
