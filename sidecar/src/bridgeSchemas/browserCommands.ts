import { z } from 'zod';

import {
  BROWSER_INPUT_SOURCES,
  BROWSER_SCROLL_DIRECTIONS,
  BROWSER_VIEWPORT_MODES,
  DESIGN_ANCHOR_KINDS,
  ELEMENT_SOURCE_CONFIDENCES,
  ELEMENT_SOURCE_FRAMEWORKS,
  type ClientCommand,
} from '../protocol.js';
import {
  MAX_BRIDGE_FRAME_BYTES,
  MAX_BRIDGE_LIST_ITEMS,
  MAX_DEVICE_SCALE_FACTOR,
  MAX_LABEL_BYTES,
  MAX_PATH_BYTES,
  boundedArray,
  boundedStringRecord,
  boxSchema,
  finiteIntSchema,
  finiteNumberSchema,
  idStringSchema,
  labelStringSchema,
  optionalLabelStringSchema,
  pathStringSchema,
  promptStringSchema,
  scrollPointSchema,
  strictCommand,
  utf8ByteString,
  viewportSchema,
} from './commandBounds.js';

const viewportModeSchema = z.enum(BROWSER_VIEWPORT_MODES);
const scrollDirectionSchema = z.enum(BROWSER_SCROLL_DIRECTIONS);
const inputSourceSchema = z.enum(BROWSER_INPUT_SOURCES);
const designAnchorKindSchema = z.enum(DESIGN_ANCHOR_KINDS);
const largeTextSchema = utf8ByteString(MAX_BRIDGE_FRAME_BYTES);
const selectorSchema = utf8ByteString(MAX_PATH_BYTES, { minBytes: 1 });
const optionalSelectorSchema = selectorSchema.optional();
const stringMapSchema = boundedStringRecord(
  utf8ByteString(MAX_PATH_BYTES),
  MAX_BRIDGE_LIST_ITEMS,
  MAX_LABEL_BYTES,
);

const elementSourceSchema = z
  .object({
    framework: z.enum(ELEMENT_SOURCE_FRAMEWORKS).optional(),
    component: optionalLabelStringSchema,
    componentChain: boundedArray(labelStringSchema).optional(),
    file: pathStringSchema.optional(),
    line: finiteIntSchema.nonnegative().optional(),
    column: finiteIntSchema.nonnegative().optional(),
    confidence: z.enum(ELEMENT_SOURCE_CONFIDENCES),
  })
  .strict();

const designAnchorAncestorSchema = z
  .object({
    tag: labelStringSchema,
    component: optionalLabelStringSchema,
    selector: optionalSelectorSchema,
  })
  .strict();

const designStrokePointSchema = z
  .object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
  })
  .strict();

const designSelectionScreenshotSchema = z
  .object({
    base64: largeTextSchema,
    box: boxSchema,
  })
  .strict();

const designAnchorSchema = z
  .object({
    id: idStringSchema,
    kind: designAnchorKindSchema,
    label: labelStringSchema,
    tag: optionalLabelStringSchema,
    role: optionalLabelStringSchema,
    name: optionalLabelStringSchema,
    text: promptStringSchema.optional(),
    box: boxSchema,
    source: elementSourceSchema.optional(),
    screenshotPath: pathStringSchema.optional(),
    strokes: boundedArray(boundedArray(designStrokePointSchema)).optional(),
  })
  .strict();

const designAnchorDetailSchema = z
  .object({
    id: idStringSchema,
    selector: selectorSchema,
    selectorVerified: z.boolean(),
    attributes: stringMapSchema,
    styles: stringMapSchema,
    ancestors: boundedArray(designAnchorAncestorSchema),
    html: largeTextSchema.optional(),
  })
  .strict();

const designReferenceSchema = z
  .object({
    id: idStringSchema,
    anchor: designAnchorSchema,
    detail: designAnchorDetailSchema.optional(),
    url: pathStringSchema,
    title: optionalLabelStringSchema,
    viewport: viewportSchema.optional(),
    scroll: scrollPointSchema.optional(),
    screenshot: designSelectionScreenshotSchema.optional(),
    createdAt: optionalLabelStringSchema,
  })
  .strict();

const browserElementRefSchema = z
  .object({
    ref: idStringSchema,
    selector: selectorSchema,
    tagName: labelStringSchema,
    role: optionalLabelStringSchema,
    name: optionalLabelStringSchema,
    text: promptStringSchema.optional(),
    attributes: stringMapSchema.optional(),
    className: optionalLabelStringSchema,
    box: boxSchema,
    computedStyles: stringMapSchema.optional(),
  })
  .strict();

const browserNativeSnapshotSchema = z
  .object({
    url: pathStringSchema,
    title: optionalLabelStringSchema,
    scroll: scrollPointSchema,
    refs: z.array(browserElementRefSchema),
    canGoBack: z.boolean().optional(),
    canGoForward: z.boolean().optional(),
  })
  .strict();

const browserElementInspectionSchema = z
  .object({
    selector: selectorSchema,
    tagName: labelStringSchema,
    role: optionalLabelStringSchema,
    name: optionalLabelStringSchema,
    text: promptStringSchema.optional(),
    attributes: stringMapSchema,
    box: boxSchema,
    html: largeTextSchema,
    iframe: z
      .object({
        src: pathStringSchema.optional(),
        accessible: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

const browserNetworkEventSchema = z
  .object({
    timestamp: finiteNumberSchema,
    method: labelStringSchema,
    url: pathStringSchema,
    resourceType: optionalLabelStringSchema,
    status: finiteIntSchema.optional(),
    error: promptStringSchema.optional(),
  })
  .strict();

const browserConsoleEventSchema = z
  .object({
    timestamp: finiteNumberSchema,
    level: finiteNumberSchema,
    message: promptStringSchema,
    line: finiteIntSchema.optional(),
    source: optionalLabelStringSchema,
  })
  .strict();

const browserNativeResultSchema = z
  .object({
    requestId: idStringSchema,
    appSessionId: idStringSchema,
    browserSessionId: idStringSchema,
    ok: z.boolean(),
    snapshot: browserNativeSnapshotSchema.optional(),
    inspection: browserElementInspectionSchema.optional(),
    networkEvents: z.array(browserNetworkEventSchema).optional(),
    consoleEvents: z.array(browserConsoleEventSchema).optional(),
    image: largeTextSchema.optional(),
    error: promptStringSchema.optional(),
  })
  .strict();

export const browserCommandSchemas = {
  'browser.open': strictCommand('browser.open', {
    appSessionId: idStringSchema,
    url: pathStringSchema,
    viewport: viewportSchema.optional(),
    viewportMode: viewportModeSchema.optional(),
  }),
  'browser.close': strictCommand('browser.close', {
    appSessionId: idStringSchema,
  }),
  'browser.reload': strictCommand('browser.reload', {
    appSessionId: idStringSchema,
  }),
  'browser.refresh': strictCommand('browser.refresh', {
    appSessionId: idStringSchema,
  }),
  'browser.resizeViewport': strictCommand('browser.resizeViewport', {
    appSessionId: idStringSchema,
    viewport: viewportSchema,
    viewportMode: viewportModeSchema,
  }),
  'browser.click': strictCommand('browser.click', {
    appSessionId: idStringSchema,
    ref: optionalLabelStringSchema,
    x: finiteNumberSchema.optional(),
    y: finiteNumberSchema.optional(),
    source: inputSourceSchema.optional(),
  }),
  'browser.type': strictCommand('browser.type', {
    appSessionId: idStringSchema,
    text: promptStringSchema,
  }),
  'browser.keypress': strictCommand('browser.keypress', {
    appSessionId: idStringSchema,
    key: labelStringSchema,
  }),
  'browser.scroll': strictCommand('browser.scroll', {
    appSessionId: idStringSchema,
    direction: scrollDirectionSchema,
    pixels: finiteNumberSchema.optional(),
    ref: optionalLabelStringSchema,
    source: inputSourceSchema.optional(),
  }),
  'browser.screenshot': strictCommand('browser.screenshot', {
    appSessionId: idStringSchema,
    fullPage: z.boolean().optional(),
    deviceScaleFactor: finiteNumberSchema.positive().max(MAX_DEVICE_SCALE_FACTOR).optional(),
  }),
  'browser.inspectPoint': strictCommand('browser.inspectPoint', {
    appSessionId: idStringSchema,
    x: finiteNumberSchema,
    y: finiteNumberSchema,
  }),
  'browser.design.addReference': strictCommand('browser.design.addReference', {
    appSessionId: idStringSchema,
    reference: designReferenceSchema,
  }),
  'browser.design.sendPrompt': strictCommand('browser.design.sendPrompt', {
    appSessionId: idStringSchema,
    instruction: promptStringSchema,
    referenceIds: boundedArray(idStringSchema),
  }),
  'browser.native.result': strictCommand('browser.native.result', {
    result: browserNativeResultSchema,
  }),
} satisfies {
  [K in Extract<
    ClientCommand['type'],
    | 'browser.open'
    | 'browser.close'
    | 'browser.reload'
    | 'browser.refresh'
    | 'browser.resizeViewport'
    | 'browser.click'
    | 'browser.type'
    | 'browser.keypress'
    | 'browser.scroll'
    | 'browser.screenshot'
    | 'browser.inspectPoint'
    | 'browser.design.addReference'
    | 'browser.design.sendPrompt'
    | 'browser.native.result'
  >]: z.ZodType<Extract<ClientCommand, { type: K }>>;
};
