import type { CaptureRect } from '../types';
export interface DesktopSnapshot {
  source: string;
  width: number;
  height: number;
  smartSelection: boolean;
}
export type DesktopMode = 'area' | 'window' | 'screen' | 'smart';
interface DesktopCaptureApi {
  ready: () => Promise<{ theme: Record<string, string> }>;
  choose: (mode: DesktopMode) => Promise<DesktopSnapshot | null>;
  selectionReady: () => Promise<void>;
  select: (rect: CaptureRect) => Promise<void>;
  cancel: () => Promise<void>;
}
declare global {
  interface Window {
    desktopCapture: DesktopCaptureApi;
  }
}
