import { z } from 'zod';

const viewportSchema = z.object({
  width: z.number().int().min(240).max(4096),
  height: z.number().int().min(240).max(4096),
  deviceScaleFactor: z.number().positive().max(4).optional(),
});

const viewportModeSchema = z.enum(['fit', 'desktop', 'laptop', 'tablet', 'mobile', 'custom']);
const scrollDirectionSchema = z.enum(['up', 'down', 'left', 'right']);

/**
 * Agent-facing name, description, and input shape for every tool the
 * first-party browser MCP server registers. Keeping them here lets the
 * permission policy read the tool names without constructing the server.
 */
export const browserMcpToolDefs = {
  open: {
    description: [
      'Navigate the live DROIDEX browser pane for this chat session to a URL explicitly requested by the user or required by the task.',
      'This is the browser the user can see and control in DROIDEX.',
      'Use snapshot—not open—when the user asks to check, inspect, explain, or continue from the current or already-open browser.',
      'Never reopen a URL from conversation memory; the user may have navigated elsewhere since the last tool call.',
      'If the user names a domain without a scheme, pass it directly; DROIDEX will load it as https.',
      'Do not ask the user for a URL when they already named a site or domain.',
      'Do not use Read, FetchUrl, curl, or agent-browser as a substitute for browser work.',
    ].join(' '),
    input: {
      url: z
        .string()
        .min(1)
        .describe('Absolute URL to open, such as https://example.com or http://127.0.0.1:1421/.'),
      viewport: viewportSchema.optional().describe('Optional explicit browser viewport.'),
      viewportMode: viewportModeSchema.optional().describe('Viewport preset label for the UI.'),
    },
  },
  snapshot: {
    description:
      'Observe the authoritative live page and refresh compact DOM refs. Use this first whenever the user refers to the current or already-open browser, because they may have navigated manually since the last tool call. Snapshot never navigates or reopens a remembered URL.',
    input: {},
  },
  reload: {
    description:
      'Reload the current live DROIDEX browser page. The result already includes fresh page refs.',
    input: {},
  },
  back: {
    description: 'Go back one page in the live DROIDEX browser history and return fresh page refs.',
    input: {},
  },
  forward: {
    description:
      'Go forward one page in the live DROIDEX browser history and return fresh page refs.',
    input: {},
  },
  screenshot: {
    description:
      'Capture the current live DROIDEX browser viewport as a high-detail PNG image for visual inspection. Use snapshot for normal navigation refs.',
    input: {
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full page instead of only the visible viewport.'),
      deviceScaleFactor: z
        .number()
        .positive()
        .max(4)
        .optional()
        .describe(
          'Temporary screenshot scale. Defaults to the current high-detail viewport scale.',
        ),
    },
  },
  click: {
    description:
      'Move the agent cursor and click in the live DROIDEX browser by ref or viewport coordinates. Prefer refs returned by snapshot.',
    input: {
      ref: z
        .string()
        .optional()
        .describe('Element ref returned by snapshot. Preferred when available.'),
      x: z.number().optional().describe('Viewport x coordinate when clicking by coordinate.'),
      y: z.number().optional().describe('Viewport y coordinate when clicking by coordinate.'),
    },
  },
  hover: {
    description:
      'Move the trusted browser pointer over an element by ref or viewport coordinates, then return fresh page refs.',
    input: {
      ref: z.string().optional().describe('Element ref returned by snapshot.'),
      x: z.number().optional().describe('Viewport x coordinate when hovering by coordinate.'),
      y: z.number().optional().describe('Viewport y coordinate when hovering by coordinate.'),
    },
  },
  select: {
    description:
      'Choose an option in a native select element by ref. The value may be the option value or visible label.',
    input: {
      ref: z.string().describe('Select element ref returned by snapshot.'),
      value: z.string().describe('Option value or exact visible label to select.'),
    },
  },
  type: {
    description:
      'Type text into the currently focused element in the live DROIDEX browser. Click or focus an input first.',
    input: {
      text: z.string().describe('Text to type into the currently focused browser element.'),
    },
  },
  keypress: {
    description: 'Press a key in the live DROIDEX browser.',
    input: {
      key: z.string().min(1).describe('Key name to press, such as Enter, Escape, Tab, ArrowDown.'),
    },
  },
  resize: {
    description:
      'Resize the viewport of the live DROIDEX browser. Use this to check responsive layouts or to match a specific screen size.',
    input: {
      viewport: viewportSchema.describe('New viewport dimensions.'),
      viewportMode: viewportModeSchema.optional().describe('Viewport preset label.'),
    },
  },
  scroll: {
    description:
      'Scroll the live DROIDEX browser page. The result already includes fresh page refs.',
    input: {
      direction: scrollDirectionSchema.describe('Direction to scroll.'),
      pixels: z.number().positive().max(4000).optional().describe('Scroll amount in pixels.'),
      ref: z.string().optional().describe('Optional ref inside a nested scroll container.'),
    },
  },
  wait: {
    description:
      'Wait for browser text, a ref, or a URL fragment before continuing. With no condition, waits for the requested duration.',
    input: {
      text: z.string().optional().describe('Visible ref text or accessible name to wait for.'),
      ref: z.string().optional().describe('Element ref to wait for.'),
      urlIncludes: z.string().optional().describe('URL fragment to wait for.'),
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(15_000)
        .optional()
        .describe('Maximum wait in milliseconds. Defaults to 5000.'),
    },
  },
  inspect: {
    description: [
      'Inspect one element without enabling Design Mode or taking another full-page snapshot.',
      'Returns bounded HTML, sanitized attributes, geometry, and iframe source/accessibility metadata.',
      'Use a ref from the latest browser response when possible, or provide a CSS selector.',
      'Credential values, auth tokens, and sensitive URL parameters are redacted.',
    ].join(' '),
    input: {
      ref: z.string().optional().describe('Element ref from the latest browser response.'),
      selector: z.string().optional().describe('CSS selector when no ref is available.'),
    },
  },
  network: {
    description: [
      'Read the latest bounded network diagnostics for this browser session.',
      'Returns at most 100 completed or failed requests with method, URL, resource type, status, and error.',
      'Headers and response bodies are never captured; credentials and sensitive URL parameters are redacted.',
    ].join(' '),
    input: {
      clear: z
        .boolean()
        .optional()
        .describe('Return the current events and clear the retained buffer afterward.'),
    },
  },
  console: {
    description: [
      'Read the latest bounded JavaScript console diagnostics for this browser session.',
      'Returns at most 100 entries with level, message, line, and source.',
      'Messages and source URLs are length-limited and credential-like values are redacted.',
    ].join(' '),
    input: {
      clear: z
        .boolean()
        .optional()
        .describe('Return the current entries and clear the retained buffer afterward.'),
    },
  },
  fill_login: {
    description: [
      'Fill the saved login for the current site in the live DROIDEX browser.',
      'You never see the username or password: the values are injected securely in the app and are redacted from every snapshot. This lets you authorize a sign-in without reading the secret.',
      'Saved logins are strictly opt-in. Use only when a sign-in form is visible and the user has previously enabled saved logins and saved a credential for this site.',
      'Returns an error if saved logins are disabled or no credential is saved; in that case ask the user to sign in once and accept the save-login prompt. After filling, submit with click or keypress; DROIDEX will request the required one-use authentication approval.',
    ].join(' '),
    input: {},
  },
  design_context: {
    description: [
      'Read the current Design Mode browser context for this chat only.',
      'Use after the user selects, clicks, or sketches an area in the live DROIDEX browser pane.',
      'Returns compact source-anchored references: each has an @id, label, kind, tag/role/name/text, box, resolved source (framework/component/file), a verified CSS selector, and a cropped screenshotPath.',
      'When you need the full element detail (all attributes, computed styles, ancestor chain, outerHTML), call design_reference with the @id instead of asking the user.',
      'Design Mode is for visual/UI work only: change the referenced elements and their styling, and do not modify backend, data, or business logic. If achieving the requested look requires a backend or data change, stop and tell the user what is needed and why instead of changing it yourself or spawning subagents.',
    ].join(' '),
    input: {
      instruction: z
        .string()
        .optional()
        .describe('Optional user design instruction to keep alongside the returned context.'),
    },
  },
  design_reference: {
    description: [
      'Fetch the full source-anchored detail for one Design Mode reference by its @id.',
      'Use the @id values returned by design_context to inspect the exact verified selector, attributes, computed styles, ancestor chain, resolved source component/file, and the cropped screenshot path before editing code.',
    ].join(' '),
    input: {
      id: z
        .string()
        .min(1)
        .describe(
          'Design reference id returned by design_context, e.g. @live-ab12cd or @region-...',
        ),
    },
  },
};

const toolNames: readonly string[] = Object.keys(browserMcpToolDefs);

/**
 * Names of every tool the browser MCP server registers, read from the shared
 * definitions above so callers (permission policy, tests) cannot drift from
 * the registrations and never have to build a server to ask.
 */
export function browserMcpToolNames(): readonly string[] {
  return toolNames;
}
