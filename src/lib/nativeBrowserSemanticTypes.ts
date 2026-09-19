import type { BrowserBox } from '../types/bridge';

export type BrowserSemanticPlane = 'semantic' | 'visual';
export type BrowserSemanticEffect = 'read' | 'local' | 'remote-write' | 'unknown';

export type BrowserSemanticEntityKind =
  | 'button'
  | 'link'
  | 'textbox'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'option'
  | 'image'
  | 'heading'
  | 'tab'
  | 'menuitem'
  | 'slider'
  | 'control'
  | 'element';

export type BrowserSemanticCapabilityAction =
  | 'open'
  | 'reload'
  | 'goBack'
  | 'goForward'
  | 'snapshot'
  | 'capture'
  | 'network'
  | 'console'
  | 'scroll'
  | 'inspect'
  | 'hover'
  | 'click'
  | 'type'
  | 'selectOption';

export interface BrowserSemanticCapability {
  action: BrowserSemanticCapabilityAction;
  plane: BrowserSemanticPlane;
  effect: BrowserSemanticEffect;
}

export interface BrowserSemanticEntityState {
  disabled: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  pressed?: boolean | 'mixed';
}

export interface BrowserSemanticEntity {
  id: string;
  selector: string;
  tagName: string;
  kind: BrowserSemanticEntityKind;
  role?: string;
  label?: string;
  text?: string;
  attributes: Record<string, string>;
  box: BrowserBox;
  state: BrowserSemanticEntityState;
  sensitive?: true;
  capabilities: BrowserSemanticCapability[];
}

export interface BrowserSemanticPage {
  url: string;
  title?: string;
  scroll: { x: number; y: number };
  canGoBack: boolean;
  canGoForward: boolean;
  capabilities: BrowserSemanticCapability[];
}

export interface BrowserSemanticState {
  revision: number;
  page: BrowserSemanticPage;
  entities: BrowserSemanticEntity[];
}

export interface BrowserSemanticPageDelta {
  urlChanged: boolean;
  titleChanged: boolean;
  scrollChanged: boolean;
  historyChanged: boolean;
  capabilitiesChanged: boolean;
}

export interface BrowserSemanticEntityDelta {
  added: BrowserSemanticEntity[];
  updated: BrowserSemanticEntity[];
  removed: string[];
  orderChanged: boolean;
}

export interface BrowserSemanticDelta {
  fromRevision: number | null;
  toRevision: number;
  reset: boolean;
  page: BrowserSemanticPageDelta;
  entities: BrowserSemanticEntityDelta;
}

export interface BrowserSemanticObservation {
  state: BrowserSemanticState;
  delta: BrowserSemanticDelta;
}

export interface BrowserSemanticObserveOptions {
  sinceRevision?: number;
}
