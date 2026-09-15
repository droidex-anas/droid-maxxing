import type { BrowserBox, BrowserElementRef, BrowserNativeSnapshot } from '../types/bridge';
import type {
  BrowserSemanticCapability,
  BrowserSemanticCapabilityAction,
  BrowserSemanticEffect,
  BrowserSemanticEntity,
  BrowserSemanticEntityKind,
  BrowserSemanticEntityState,
  BrowserSemanticPlane,
  BrowserSemanticState,
} from './nativeBrowserSemanticTypes';

const MAX_LABEL_LENGTH = 160;
const MAX_TEXT_LENGTH = 320;
const MAX_ATTRIBUTE_LENGTH = 500;

const SAFE_ATTRIBUTES = new Set([
  'action',
  'alt',
  'aria-checked',
  'aria-current',
  'aria-disabled',
  'aria-expanded',
  'aria-haspopup',
  'aria-label',
  'aria-pressed',
  'aria-selected',
  'autocomplete',
  'checked',
  'contenteditable',
  'data-testid',
  'disabled',
  'href',
  'id',
  'name',
  'placeholder',
  'rel',
  'role',
  'selected',
  'src',
  'target',
  'title',
  'type',
]);

const TEXTBOX_INPUT_TYPES = new Set([
  '',
  'date',
  'datetime-local',
  'email',
  'month',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'time',
  'url',
  'week',
]);

const WRITE_LABEL_PATTERN =
  /\b(add|apply|archive|assign|book|buy|checkout|close|confirm|create|delete|invite|merge|order|pay|post|publish|purchase|remove|save|send|share|submit|transfer|upload)\b/i;

const SENSITIVE_FIELD_PATTERN =
  /\b(api[-_ ]?key|card(?: number)?|credential|credit card|cvc|cvv|one[-_ ]?time|otp|passcode|password|pin|private[-_ ]?key|secret|security code|social security|ssn|token|verification code)\b/i;

const PAGE_CAPABILITIES: BrowserSemanticCapability[] = [
  capability('snapshot', 'semantic', 'read'),
  capability('capture', 'visual', 'read'),
  capability('network', 'semantic', 'read'),
  capability('console', 'semantic', 'read'),
  capability('open', 'semantic', 'local'),
  capability('reload', 'semantic', 'local'),
  capability('goBack', 'semantic', 'local'),
  capability('goForward', 'semantic', 'local'),
  capability('scroll', 'semantic', 'local'),
];

function capability(
  action: BrowserSemanticCapabilityAction,
  plane: BrowserSemanticPlane,
  effect: BrowserSemanticEffect,
): BrowserSemanticCapability {
  return { action, plane, effect };
}

function compactText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.slice(0, maxLength);
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function safeBox(box: BrowserBox): BrowserBox {
  return {
    x: safeNumber(box.x),
    y: safeNumber(box.y),
    width: Math.max(0, safeNumber(box.width)),
    height: Math.max(0, safeNumber(box.height)),
  };
}

function safeUrlAttribute(value: string): string | undefined {
  const compact = compactText(value, MAX_ATTRIBUTE_LENGTH);
  if (!compact) return undefined;
  if (/^(?:data|javascript):/i.test(compact)) return undefined;
  return compact;
}

function safeAttributes(attributes: Record<string, string> | undefined): Record<string, string> {
  if (!attributes) return {};

  const safe: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(attributes).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const name = rawName.toLowerCase();
    if (!SAFE_ATTRIBUTES.has(name) || name === 'value') continue;

    const value =
      name === 'href' || name === 'src' || name === 'action'
        ? safeUrlAttribute(rawValue)
        : compactText(rawValue, MAX_ATTRIBUTE_LENGTH);
    if (value !== undefined) safe[name] = value;
  }
  return safe;
}

function booleanAttribute(
  attributes: Record<string, string>,
  nativeName: string,
  ariaName = `aria-${nativeName}`,
): boolean {
  const nativeValue = attributes[nativeName];
  if (nativeValue !== undefined) {
    const value = nativeValue.toLowerCase();
    return value !== 'false' && value !== '0';
  }
  return attributes[ariaName]?.toLowerCase() === 'true';
}

function tristateAttribute(
  attributes: Record<string, string>,
  nativeName: string,
  ariaName = `aria-${nativeName}`,
): boolean | 'mixed' | undefined {
  const raw = attributes[ariaName] ?? attributes[nativeName];
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (value === 'mixed') return 'mixed';
  if (value === 'true' || value === '' || value === nativeName) return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function stateBooleanAttribute(
  attributes: Record<string, string>,
  nativeName: string,
  ariaName = `aria-${nativeName}`,
): boolean | undefined {
  const value = tristateAttribute(attributes, nativeName, ariaName);
  return typeof value === 'boolean' ? value : undefined;
}

function inferKind(
  ref: BrowserElementRef,
  attributes: Record<string, string>,
): BrowserSemanticEntityKind {
  const tagName = ref.tagName.toLowerCase();
  const role = (ref.role ?? attributes['role'] ?? '').toLowerCase();
  const type = (attributes['type'] ?? '').toLowerCase();

  if (role === 'button') return 'button';
  if (role === 'link') return 'link';
  if (role === 'textbox' || role === 'searchbox') return 'textbox';
  if (role === 'combobox' || role === 'listbox') return 'select';
  if (role === 'checkbox') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (role === 'switch') return 'switch';
  if (role === 'option') return 'option';
  if (role === 'img') return 'image';
  if (role === 'heading') return 'heading';
  if (role === 'tab') return 'tab';
  if (role === 'menuitem') return 'menuitem';
  if (role === 'slider') return 'slider';

  if (tagName === 'button') return 'button';
  if (tagName === 'a' && attributes['href']) return 'link';
  if (tagName === 'textarea') return 'textbox';
  if (tagName === 'select') return 'select';
  if (tagName === 'option') return 'option';
  if (tagName === 'img') return 'image';
  if (/^h[1-6]$/.test(tagName)) return 'heading';
  if (attributes['contenteditable'] === 'true' || attributes['contenteditable'] === '') {
    return 'textbox';
  }

  if (tagName === 'input') {
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
      return 'button';
    }
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (TEXTBOX_INPUT_TYPES.has(type)) return 'textbox';
    return 'control';
  }

  if (role || ref.attributes?.['data-testid']) return 'control';
  return 'element';
}

function isSensitiveField(
  ref: BrowserElementRef,
  attributes: Record<string, string>,
  kind: BrowserSemanticEntityKind,
): boolean {
  if (kind !== 'textbox') return false;
  if (attributes['type']?.toLowerCase() === 'password') return true;

  const autocomplete = attributes['autocomplete']?.toLowerCase() ?? '';
  if (autocomplete.includes('password') || autocomplete === 'one-time-code') return true;

  return SENSITIVE_FIELD_PATTERN.test(
    [
      attributes['id'],
      attributes['name'],
      attributes['placeholder'],
      attributes['aria-label'],
      attributes['title'],
      ref.name,
      ref.text,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function clickEffect(
  kind: BrowserSemanticEntityKind,
  attributes: Record<string, string>,
  label: string | undefined,
): BrowserSemanticEffect {
  if (kind === 'link') return 'local';
  if (attributes['type']?.toLowerCase() === 'submit') return 'remote-write';
  if (label && WRITE_LABEL_PATTERN.test(label)) return 'remote-write';
  return 'unknown';
}

function entityCapabilities(
  kind: BrowserSemanticEntityKind,
  attributes: Record<string, string>,
  label: string | undefined,
  disabled: boolean,
): BrowserSemanticCapability[] {
  const capabilities = [
    capability('inspect', 'semantic', 'read'),
    capability('hover', 'semantic', 'local'),
  ];

  if (disabled) return capabilities;

  if (
    kind === 'button' ||
    kind === 'link' ||
    kind === 'checkbox' ||
    kind === 'radio' ||
    kind === 'switch' ||
    kind === 'tab' ||
    kind === 'menuitem' ||
    attributes['role'] === 'button'
  ) {
    capabilities.push(capability('click', 'semantic', clickEffect(kind, attributes, label)));
  }
  if (kind === 'textbox') capabilities.push(capability('type', 'semantic', 'local'));
  if (kind === 'select') capabilities.push(capability('selectOption', 'semantic', 'local'));

  return capabilities;
}

function buildEntity(ref: BrowserElementRef): BrowserSemanticEntity {
  const attributes = safeAttributes(ref.attributes);
  const kind = inferKind(ref, attributes);
  const sensitive = isSensitiveField(ref, attributes, kind);
  const regularLabel =
    compactText(ref.name, MAX_LABEL_LENGTH) ??
    compactText(attributes['aria-label'], MAX_LABEL_LENGTH) ??
    compactText(attributes['title'], MAX_LABEL_LENGTH) ??
    compactText(attributes['alt'], MAX_LABEL_LENGTH) ??
    compactText(attributes['placeholder'], MAX_LABEL_LENGTH) ??
    compactText(ref.text, MAX_LABEL_LENGTH);
  const sensitiveLabel = [
    attributes['aria-label'],
    attributes['title'],
    attributes['placeholder'],
    attributes['name'],
    ref.name,
  ]
    .map((value) => compactText(value, MAX_LABEL_LENGTH))
    .find((value) => value !== undefined && SENSITIVE_FIELD_PATTERN.test(value));
  const label = sensitive ? (sensitiveLabel ?? 'Sensitive text field') : regularLabel;
  const text = compactText(ref.text, MAX_TEXT_LENGTH);
  const disabled = booleanAttribute(attributes, 'disabled');

  const role = compactText(ref.role ?? attributes['role'], 80);
  const safeText = text === label || sensitive ? undefined : text;
  const state: BrowserSemanticEntityState = { disabled };
  const checked = tristateAttribute(attributes, 'checked');
  const selected = stateBooleanAttribute(attributes, 'selected');
  const expanded = stateBooleanAttribute(attributes, 'expanded');
  const pressed = tristateAttribute(attributes, 'pressed');
  if (checked !== undefined) state.checked = checked;
  if (selected !== undefined) state.selected = selected;
  if (expanded !== undefined) state.expanded = expanded;
  if (pressed !== undefined) state.pressed = pressed;

  return {
    id: ref.ref,
    selector: ref.selector,
    tagName: ref.tagName.toLowerCase(),
    kind,
    ...(role === undefined ? {} : { role }),
    ...(label === undefined ? {} : { label }),
    ...(safeText === undefined ? {} : { text: safeText }),
    attributes,
    box: safeBox(ref.box),
    state,
    ...(sensitive ? { sensitive: true as const } : {}),
    capabilities: entityCapabilities(kind, attributes, label, disabled),
  };
}

function clonePageCapabilities(): BrowserSemanticCapability[] {
  return PAGE_CAPABILITIES.map((item) => ({ ...item }));
}

export function buildBrowserSemanticState(
  snapshot: BrowserNativeSnapshot,
  revision = 1,
): BrowserSemanticState {
  const seen = new Set<string>();
  const entities: BrowserSemanticEntity[] = [];
  for (const ref of snapshot.refs) {
    if (!ref.ref || seen.has(ref.ref)) continue;
    seen.add(ref.ref);
    entities.push(buildEntity(ref));
  }

  const title = compactText(snapshot.title, MAX_TEXT_LENGTH);
  return {
    revision: Number.isFinite(revision) ? Math.max(1, Math.trunc(revision)) : 1,
    page: {
      url: snapshot.url,
      ...(title === undefined ? {} : { title }),
      scroll: {
        x: safeNumber(snapshot.scroll.x),
        y: safeNumber(snapshot.scroll.y),
      },
      canGoBack: snapshot.canGoBack === true,
      canGoForward: snapshot.canGoForward === true,
      capabilities: clonePageCapabilities(),
    },
    entities,
  };
}

export function browserSemanticStateEquals(
  left: BrowserSemanticState,
  right: BrowserSemanticState,
): boolean {
  return (
    JSON.stringify(left.page) === JSON.stringify(right.page) &&
    JSON.stringify(left.entities) === JSON.stringify(right.entities)
  );
}
