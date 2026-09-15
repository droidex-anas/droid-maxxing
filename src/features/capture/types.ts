export type CapturePreset = 'ember' | 'tide' | 'pearl' | 'iris' | 'graphite' | 'transparent';
export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CaptureStyle {
  colors?: [string, string, string];
  preset: CapturePreset;
  padding: number;
  radius: number;
  shadow: number;
  texture: number;
}
export interface CaptureRecipe {
  version: 1;
  crop: CaptureRect;
  style: CaptureStyle;
}
export interface CapturePreferences {
  version: 1;
  style: CaptureStyle;
  sound: boolean;
  smartSelection: boolean;
  shortcut: string;
}
export interface CaptureStatus {
  preferences: CapturePreferences;
  nativeAvailable: boolean;
  shortcutRegistered: boolean;
}
export interface CaptureRecord {
  id: string;
  title: string;
  createdAt: number;
  revision: number;
  width: number;
  height: number;
  recipe: CaptureRecipe;
  hasExport: boolean;
}
export interface CaptureDocument extends CaptureRecord {
  source: string;
}
export interface CaptureMetadata {
  id: string;
  title: string;
  width: number;
  height: number;
}
export interface CaptureAttachment {
  path: string;
  preview: string;
  capture: CaptureMetadata;
}
export type CaptureMode = 'area' | 'window' | 'screen' | 'component' | 'desktop';
export interface CaptureApi {
  preferences(): Promise<CaptureStatus>;
  setPreferences(value: CapturePreferences): Promise<CaptureStatus>;
  take(request: {
    requestId: string;
    mode: CaptureMode;
    rect?: CaptureRect;
    title?: string;
    theme?: Record<string, string>;
  }): Promise<CaptureDocument | null>;
  cancel(requestId: string): Promise<void>;
  import(source: string, title: string): Promise<CaptureDocument>;
  read(id: string): Promise<CaptureDocument>;
  list(): Promise<CaptureRecord[]>;
  thumbnail(id: string): Promise<string | null>;
  delete(id: string): Promise<void>;
  save(id: string, revision: number, recipe: CaptureRecipe, output: string): Promise<CaptureRecord>;
  copy(id: string): Promise<void>;
  export(id: string): Promise<boolean>;
  attach(id: string): Promise<CaptureAttachment>;
  onShortcut(handler: () => void): () => void;
}
declare global {
  interface Window {
    droidCapture?: CaptureApi;
  }
}
export function captureApi(): CaptureApi {
  if (!window.droidCapture) throw new Error('Capture needs the DROIDEX desktop app');
  return window.droidCapture;
}
