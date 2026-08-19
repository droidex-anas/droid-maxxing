# Agentic browser semantic state

DROIDEX already has two useful browser inputs:

- high-quality captures for visual reasoning and design work;
- lightweight DOM references returned after native browser actions.

These inputs solve different problems. A capture answers “what does this look like?” A semantic state answers “what exists, what changed, and what can the agent do precisely?” The semantic state layer keeps both instead of replacing visual capture.

## What this slice adds

`BrowserSemanticStateTracker` compiles each existing `BrowserNativeSnapshot` into a compact state:

```ts
{
  revision: 12,
  page: {
    url: 'https://example.com/settings',
    scroll: { x: 0, y: 480 },
    capabilities: [
      { action: 'snapshot', plane: 'semantic', effect: 'read' },
      { action: 'capture', plane: 'visual', effect: 'read' },
      { action: 'scroll', plane: 'semantic', effect: 'local' },
    ],
  },
  entities: [
    {
      id: '@b-12ab34cd',
      kind: 'button',
      label: 'Save changes',
      selector: '[data-testid="save"]',
      capabilities: [
        { action: 'inspect', plane: 'semantic', effect: 'read' },
        { action: 'click', plane: 'semantic', effect: 'remote-write' },
      ],
    },
  ],
}
```

The tracker keeps a bounded revision history and returns deltas:

```ts
{
  fromRevision: 11,
  toRevision: 12,
  page: { scrollChanged: true },
  entities: {
    added: [],
    updated: ['@b-12ab34cd'],
    removed: [],
  },
}
```

An agent can therefore receive the initial state once and only the meaningful changes after later actions.

## Using it

Ordinary `performNativeBrowserRequest()` calls now populate semantic state while preserving their existing return value and protocol shape:

```ts
const result = await performNativeBrowserRequest(request);
const state = getNativeBrowserSemanticState(request.browserSessionId);
```

A caller that wants the result and delta together can use the opt-in wrapper:

```ts
const { result, observation } =
  await performNativeBrowserRequestWithSemanticState(request, {
    sinceRevision: previousRevision,
  });

if (observation) {
  previousRevision = observation.state.revision;
  agentContext.browser = observation.delta.reset
    ? observation.state
    : observation.delta;
}
```

If a requested revision has fallen out of the bounded history, `delta.reset` is `true` and the current entities are returned as a fresh baseline.

## Visual capture remains separate

Nothing in this slice changes Design Mode, design anchors, screenshots, or native capture quality. A design task can still request a high-quality capture:

```ts
const capture = await performNativeBrowserRequest({
  ...request,
  action: 'capture',
  fullPage: true,
  deviceScaleFactor: 2,
});
```

The intended routing is:

- use semantic state for navigation, controls, exact actions, waiting, and change detection;
- use high-quality capture for layout, hierarchy, styling, reference matching, and visual verification;
- combine both when an agent must connect pixels to a DOM element or source component.

## Safety and compactness

The semantic compiler:

- omits all `value` attributes, even when the field is not marked sensitive;
- suppresses text from password, passcode, token, OTP, card, and similar fields;
- keeps only a small attribute allowlist;
- drops `data:` and `javascript:` URL attributes;
- classifies obvious submit/save/send/delete-style clicks as possible remote writes;
- treats uncertain button clicks conservatively as `unknown` rather than claiming they are safe.

These classifications are hints for a future permission kernel, not authorization decisions by themselves.

## Current boundary

This is the first state-model slice, not the full agent browser runtime.

- State refreshes when the existing native action path returns a snapshot. It is not yet a continuous MutationObserver/CDP event stream.
- It inherits the current preload snapshot limit of 80 candidate elements.
- Entity identity uses the existing stable `@b-*` references.
- Capability inference is generic and conservative; site-provided WebMCP or learned network actions can be layered above it later.
- The sidecar protocol is unchanged. A later PR can add an explicit semantic-state event after the state shape has settled.

The next useful step is an event bridge that publishes state deltas after DOM, navigation, and network changes without forcing another full agent observation cycle.
