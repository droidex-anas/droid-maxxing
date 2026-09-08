import { createSdkMcpServer, tool } from '@factory/droid-sdk';
import { readFile } from 'node:fs/promises';
import type { BrowserSessionManager } from './BrowserSessionManager.js';
import { browserMcpToolDefs as defs } from './browserMcpToolDefs.js';
import type { BrowserState, DesignReference } from './types.js';
import { jsonResult, safeTool, type ToolHandlerResult } from '../mcpToolUtils.js';

export function createBrowserMcpServer(
  manager: BrowserSessionManager,
  appSessionIdForTool: () => string | undefined,
) {
  const appSessionId = () => {
    const id = appSessionIdForTool();
    if (!id) throw new Error('Browser tools are not attached to a live DROIDEX session yet.');
    return id;
  };

  return createSdkMcpServer({
    name: 'droidex-browser',
    version: '0.1.0',
    tools: [
      tool(
        'open',
        defs.open.description,
        defs.open.input,
        safeTool(async (input) => {
          const state = await manager.open({
            appSessionId: appSessionId(),
            url: input.url,
            viewport: input.viewport
              ? { ...input.viewport, deviceScaleFactor: input.viewport.deviceScaleFactor ?? 2 }
              : undefined,
            viewportMode: input.viewportMode ?? (input.viewport ? 'custom' : undefined),
          });
          return jsonResult({
            message:
              'Opened the live DROIDEX browser. The response includes current page refs; use them directly with click, type, and scroll.',
            ...stateForTool(state),
          });
        }),
      ),
      tool(
        'snapshot',
        defs.snapshot.description,
        defs.snapshot.input,
        safeTool(async () => {
          const state = await manager.refresh(appSessionId());
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'reload',
        defs.reload.description,
        defs.reload.input,
        safeTool(async () => {
          const state = await manager.reload(appSessionId());
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'back',
        defs.back.description,
        defs.back.input,
        safeTool(async () => {
          const state = await manager.goBack(appSessionId());
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'forward',
        defs.forward.description,
        defs.forward.input,
        safeTool(async () => {
          const state = await manager.goForward(appSessionId());
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'screenshot',
        defs.screenshot.description,
        defs.screenshot.input,
        safeTool(async (input) => {
          const path = await manager.screenshot(appSessionId(), {
            fullPage: input.fullPage ?? false,
            deviceScaleFactor: input.deviceScaleFactor,
          });
          return imageToolResult(path, { ok: true, screenshotPath: path, mimeType: 'image/png' });
        }),
      ),
      tool(
        'click',
        defs.click.description,
        defs.click.input,
        safeTool(async (input) => {
          const state = await manager.click({
            appSessionId: appSessionId(),
            ref: input.ref,
            x: input.x,
            y: input.y,
          });
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'hover',
        defs.hover.description,
        defs.hover.input,
        safeTool(async (input) => {
          const state = await manager.hover({
            appSessionId: appSessionId(),
            ref: input.ref,
            x: input.x,
            y: input.y,
          });
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'select',
        defs.select.description,
        defs.select.input,
        safeTool(async (input) => {
          const state = await manager.selectOption(appSessionId(), input.ref, input.value);
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'type',
        defs.type.description,
        defs.type.input,
        safeTool(async (input) => {
          const state = await manager.type(appSessionId(), input.text);
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'keypress',
        defs.keypress.description,
        defs.keypress.input,
        safeTool(async (input) => {
          const state = await manager.keypress(appSessionId(), input.key);
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'resize',
        defs.resize.description,
        defs.resize.input,
        safeTool(async (input) => {
          const state = await manager.resizeViewport({
            appSessionId: appSessionId(),
            viewport: {
              ...input.viewport,
              deviceScaleFactor: input.viewport.deviceScaleFactor ?? 2,
            },
            viewportMode: input.viewportMode ?? 'custom',
          });
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'scroll',
        defs.scroll.description,
        defs.scroll.input,
        safeTool(async (input) => {
          const state = await manager.scroll(
            appSessionId(),
            input.direction,
            input.pixels,
            undefined,
            input.ref,
          );
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'wait',
        defs.wait.description,
        defs.wait.input,
        safeTool(async (input) => {
          const state = await manager.wait(appSessionId(), input);
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'inspect',
        defs.inspect.description,
        defs.inspect.input,
        safeTool(async (input) => {
          const inspection = await manager.inspect(appSessionId(), input);
          return jsonResult({ ok: true, inspection });
        }),
      ),
      tool(
        'network',
        defs.network.description,
        defs.network.input,
        safeTool(async (input) => {
          const events = await manager.network(appSessionId(), input.clear ?? false);
          return jsonResult({ ok: true, events });
        }),
      ),
      tool(
        'console',
        defs.console.description,
        defs.console.input,
        safeTool(async (input) => {
          const events = await manager.console(appSessionId(), input.clear ?? false);
          return jsonResult({ ok: true, events });
        }),
      ),
      tool(
        'fill_login',
        defs.fill_login.description,
        defs.fill_login.input,
        safeTool(async () => {
          const state = await manager.fillCredentials(appSessionId());
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'design_context',
        defs.design_context.description,
        defs.design_context.input,
        safeTool(async (input) => {
          const id = appSessionId();
          await manager.refresh(id);
          const context = manager.designContext(id);
          const refs = context.references;
          const images = refs.flatMap((ref) =>
            ref.screenshot
              ? [
                  {
                    type: 'image' as const,
                    data: ref.screenshot.base64,
                    mimeType: 'image/png' as const,
                  },
                ]
              : [],
          );
          const result = jsonResult({
            ok: true,
            instruction: input.instruction,
            ...stateForTool(context.state, refs),
          });
          if (images.length > 0) {
            return { content: [{ type: 'text' as const, text: result }, ...images] };
          }
          return result;
        }),
      ),
      tool(
        'design_reference',
        defs.design_reference.description,
        defs.design_reference.input,
        safeTool(async (input) => {
          const id = appSessionId();
          await manager.refresh(id);
          const ref = manager.referenceDetail(id, input.id);
          if (!ref) {
            return jsonResult({
              ok: false,
              error: `No design reference ${input.id}. Call design_context to list the current references.`,
            });
          }
          const text = jsonResult({ ok: true, reference: designReferenceDetail(ref) });
          if (ref.screenshot?.base64) {
            return {
              content: [
                { type: 'text' as const, text },
                {
                  type: 'image' as const,
                  data: ref.screenshot.base64,
                  mimeType: 'image/png' as const,
                },
              ],
            };
          }
          return text;
        }),
      ),
    ],
  });
}

function stateForTool(
  state: BrowserState,
  designReferences: DesignReference[] = [],
): Record<string, unknown> {
  return {
    ok: true,
    url: state.url,
    title: state.title,
    viewport: state.viewport,
    viewportMode: state.viewportMode,
    screenshotPath: state.screenshotPath,
    scroll: state.scroll,
    scrollResult: state.scrollResult,
    canGoBack: state.canGoBack ?? false,
    canGoForward: state.canGoForward ?? false,
    refs: state.refs.map((ref) => ({
      ref: ref.ref,
      tagName: ref.tagName,
      role: ref.role,
      name: ref.name,
      text: ref.text,
      selector: ref.selector,
      attributes: ref.attributes,
      box: ref.box,
    })),
    designReferences: designReferences.map(designReferenceSummary),
  };
}

function designReferenceSummary(ref: DesignReference): Record<string, unknown> {
  const anchor = ref.anchor;
  const out: Record<string, unknown> = {
    id: ref.id,
    kind: anchor.kind,
    label: anchor.label,
    tag: anchor.tag,
    role: anchor.role,
    name: anchor.name,
    text: anchor.text,
    box: anchor.box,
    source: anchor.source,
    selector: ref.detail?.selector,
    selectorVerified: ref.detail?.selectorVerified,
    screenshotPath: anchor.screenshotPath,
    url: ref.url,
  };
  if (anchor.strokes) out.strokes = anchor.strokes;
  // The annotated screenshot bytes are returned as a separate image block by
  // the design_context / design_reference tools; keep them out of the JSON to
  // avoid duplicating large base64 payloads.
  if (ref.screenshot) out.hasScreenshot = true;
  return out;
}

function designReferenceDetail(ref: DesignReference): Record<string, unknown> {
  return {
    ...designReferenceSummary(ref),
    title: ref.title,
    viewport: ref.viewport,
    scroll: ref.scroll,
    createdAt: ref.createdAt,
    detail: ref.detail
      ? {
          selector: ref.detail.selector,
          selectorVerified: ref.detail.selectorVerified,
          attributes: ref.detail.attributes,
          styles: ref.detail.styles,
          ancestors: ref.detail.ancestors,
          html: ref.detail.html,
        }
      : undefined,
  };
}

async function imageToolResult(path: string, metadata: unknown): Promise<ToolHandlerResult> {
  return {
    content: [
      { type: 'text', text: jsonResult(metadata) },
      { type: 'image', data: await readFile(path, 'base64'), mimeType: 'image/png' },
    ],
  };
}
