export type NotificationPermissionResult = 'granted' | 'denied' | 'default' | 'unsupported';

export async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted' || permission === 'denied') return permission;
    return 'default';
  } catch {
    return 'unsupported';
  }
}
