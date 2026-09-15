# Remote onboarding artwork

A compact SVG pairing walkthrough and a standalone, shareable SVG guide.
The illustrations are separate from connection telemetry. They contain no
usable QR, pairing ticket, model name, provider credential, bitmap, external
font, or network request. Real pairing controls remain outside the artwork.

## Edit and preview

- Edit `banner.svg` for the phone, computer, lighting, and 16-second morph cycle.
- Edit `player.js` / `player.css` for playback controls and compact layout.
- Edit `tools/remote-artwork-guide.svg` for the share guide's layout and wording.
- Run `node tools/build-remote-artwork.mjs` from the repository root. It embeds
  the same device definitions in `guide.svg` and produces self-contained
  `banner.html`, including an exact script hash in its Content Security Policy.
- Open `banner.html` in a browser to preview. No development server is needed.

`banner.svg` animates independently when opened in a supporting browser;
`banner.html` adds chapter navigation, pause/replay and lifecycle controls.
`guide.svg` is a static image suitable for sharing. Some chat/image previews
render only the first frame of an animated SVG; the HTML is the playback preview.

## App integration

The desktop pairing window embeds `banner.html` and saves `guide.svg` through
its existing sender-checked IPC, using a native Save dialog. Electron's existing
`electron/**` packaging includes the artwork. No renderer credentials are sent
to the frame; its CSP forbids connections.

The Xcode project copies the same `RemoteArtwork` folder from
`../../electron/mobile/RemoteArtwork` into its resources. Keep the repository
layout when opening the project. `RemoteOnboardingArtwork.swift` embeds the
local HTML in a non-persistent WKWebView with navigation restricted to that
file. The iOS Share button shares the bundled SVG. The view suspends playback
on backgrounding and honors Reduce Motion. It displays readable instructions
instead of a blank banner if the resource fails to load.

An embedding frame may send `{ type: 'droidex.remote-artwork', active: false }`
to suspend playback. `step: 0 | 1 | 2 | 3` pins an illustrative chapter;
`step: null` returns to user-controlled playback. The only accepted messages
come from the parent window. The native wrapper calls the same bounded API.
Pinning a chapter disables manual chapter/replay controls; it never changes
pairing or session state. The QR wording says "when offered" so it also works
with the current copy/paste-only pairing route.

The editable phone uses the iPhone 17 Pro's published 71.9:150 body proportions.
Its paths, bezel, highlights, camera and buttons are original illustrative
geometry, not an official Apple SVG, CAD drawing or exact optical simulation.
Reference: https://www.apple.com/iphone-17-pro/specs/

## Verification

`node tools/build-remote-artwork.mjs --check` rejects stale generated assets.
`tools/remoteArtwork.test.ts` is picked up by the existing Node test script.
`tests/integration/remote-artwork.spec.ts` covers the rendered geometry,
keyboard playback, Reduce Motion, host suspension and compact layout in the
existing Playwright suite. Native WKWebView rendering and the share/save sheets
still require Xcode/Electron testing on the target operating systems.
