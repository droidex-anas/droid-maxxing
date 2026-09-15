# Capture

Capture is a desktop presentation feature, not an agent-harness capability. It never sends a prompt automatically and does not require a model or network service.

## User workflow

There are two entry points. **Composer → + → Screenshot** keeps the in-app chooser and editor, including image import and live Droidex component selection. The configurable global shortcut (initially Command/Ctrl + Shift + 2) instead opens a small **desktop toolbar on the display under the pointer**, without restoring or focusing the main Droidex window first. The app must be running with a composer available.

The desktop toolbar offers **Area, Window, Display, and Smart area**. Area and Window use the native macOS selector. Display samples the display under the pointer at invocation, not an unrelated primary monitor. Smart area freezes that display and offers editable visual region suggestions over browser pages and other visible apps. Escape, closing the panel, or pressing the shortcut again cancels without bringing Droidex forward. A successful capture returns to Droidex and the initiating draft. The in-app Full screen choice still means the primary display.

Desktop capture is macOS-only in this draft. Windows and Linux retain in-app component capture, import, editing, history, and clipboard operations.

The normal path captures, applies the saved background, and attaches a screenshot card to the initiating composer. **Refine before attaching** opens the editor first. Clicking a captured card reopens its original and replaces that card only after a successful save and attachment copy. The text draft is not submitted or cleared by Capture.

**Settings → Screenshots** contains persistent presentation defaults, sound, selection assistance, shortcut configuration, and Recent captures. The default changes only through Save defaults / Make this my default. Per-image edits never silently change future captures. Recents supports editing, full-resolution image copy, PNG export, attaching to the active draft, and deleting the original plus its edits.

## Selection contract

Live Droidex component selection walks visible DOM ancestors. Hover, click, or use the larger/smaller controls to move from a control into its containing section. The overlay is removed before capture, and CSS bounds are converted through the renderer zoom factor before Electron captures the selected rectangle. This mode selects the main renderer, not the separate embedded-browser WebContentsView.

The desktop **Smart area** picker uses the pixels of the current screen, not Droidex's DOM. Hover to preview a proposed region, click to lock it, then use Larger/Smaller or the arrow keys to change nesting. Drag a rectangle when no useful proposal appears. Enter or Capture confirms; Option bypasses snapping while dragging. The screen is frozen during selection: users are not clicking or modifying the app underneath. This mode is limited to one display per invocation; Area/Window remain available for native selection.

Imported and desktop screenshots have no DOM tree. The refinement tool uses bounded local raster analysis to suggest long coherent panel boundaries. Click a proposed panel or drag a rough rectangle; nearby, substantially overlapping boundaries snap. Option/Alt disables snapping. Numeric source-pixel controls and arrow-key adjustments remain available. Low-confidence or oversized selections are not silently replaced. These are editable geometric suggestions, not guaranteed semantic recognition or a universal macOS accessibility-tree implementation.

Nothing regenerates text, icons, or code. A flattened screenshot cannot recover pixels outside the initial capture or separate a translucent component from wallpaper already composited into it.

## Image and delivery invariants

- Native capture and import create immutable PNG sources. Captured UI text never goes through the ordinary image-paste downscaling tier.
- The recipe stores an integer source-pixel crop plus presentation controls. Export draws that crop at its original size and adds padding. Preview scaling does not affect export resolution.
- There is no misleading upscaling multiplier. The decoded image/composition limit is 48 megapixels and 16000 pixels per edge; PNG payloads are capped at 40 MiB. Oversized exports fail visibly rather than shrinking silently.
- Only thumbnails are resized. Clipboard copy writes an image, not a preview URL or filesystem path. Native attachments use a fresh independent copy in the existing attachment store.
- A composer generation owns delivery. Leaving and returning to the same chat, changing target, closing Capture, submission, and unmount invalidate older results. Late attachment files are discarded. History remains available if attachment delivery is cancelled.
- Native capture suppresses the system shutter sound. The optional quiet click belongs to successful captures only, and reduced-motion settings disable decorative capture motion.

## Ownership and storage

`electron/capture/desktopPicker.cjs` owns a separate nonactivating macOS panel, a three-minute lifetime, and panel-only IPC. Its sandboxed preload exposes only picker readiness, mode selection, selection confirmation, and cancellation; it cannot call the main app's capture history, attachment, shell, or agent APIs. Navigation, new windows, webviews and permission requests are denied. `capture.html` is a separate small Vite entry with its own styles and a strict production CSP. The panel does not transform the application's process type or hide its Dock icon.

The toolbar is hidden before acquiring pixels. `desktopSnapshot.cjs` matches the cursor display by ID and rejects empty, mismatched, or undersized samples rather than upscaling. Smart area retains its full-display snapshot in memory only while selecting and saves **only the confirmed crop** to Recents. The usual original-outside-edited-crop warning still applies to later editor crops. Display reconfiguration, timeout, renderer failure, panel close, and owner cancellation dispose the panel and stop native acquisition.

`electron/capture/service.cjs` owns trusted-main-frame IPC, native capture lifetime, global shortcut registration, clipboard, save dialogs, and attachment-copy handoff. `native.cjs` invokes the Apple-signed `/usr/sbin/screencapture` executable with argument arrays, no shell, an AbortSignal, a timeout, and private temporary-file cleanup. Main renderer reload/close and app quit abort in-flight capture.

`electron/capture/store.cjs` serializes local writes under the DROIDEX user-data `captures/` directory. It uses private directory/file permissions, UUID-only filenames, PNG/geometry validation, atomic metadata replacement, and revision checks. Sources, thumbnails, recipes, and rendered exports are separate. An interrupted export is marked unavailable rather than paired with a stale recipe. Recents is capped at 30 captures, 30 days, and 512 MiB, evicting oldest records. It is local plaintext storage, not encrypted cloud backup.

The stored original may contain content outside the current crop. Users should delete captures containing sensitive material when no longer needed. Capture does not add screenshot contents or image payloads to diagnostics or agent history. Sending a prompt with the attachment uses the app's existing provider/attachment behavior and is a separate explicit user action.

The feature UI lives in `src/features/capture/`. The composer loads the editor lazily. Screenshot bitmaps are not placed in the global conversation store, and Capture does not change the sidecar protocol.

## Validation before leaving draft

Automated checks cover shortcut routing without main-window activation, panel IPC ownership and cleanup, display identity and physical sizing, cancellation during sampling, external-region selection and keyboard interaction in the real desktop React entry with acquisition mocked, source-pixel geometry, conservative snapping, nested synthetic UI boundaries, generation ownership, PNG limits, store persistence/revisions/eviction/symlink refusal, IPC sender isolation, native argument construction/cancellation, and zoom/density conversion. These do not substitute for permissioned desktop capture on a real Mac.

Required manual acceptance on a packaged Mac build:

1. Invoke the global shortcut while another app is active, with Droidex minimized, hidden, on another Space, and behind a full-screen browser. Only the toolbar should appear on the pointer's display; the main app and Dock icon must stay unchanged until successful capture. Escape must restore the previous working context. Test first permission request, denial, granting access after denial, app restart, and revocation. Confirm the privacy prompt is attributed correctly to the packaged DROIDEX app.
2. Capture an area, native window, primary display, and nested Droidex component. Test Retina, non-Retina, mixed-density monitors, negative display origins, app zoom, and multi-display area/window selection. Confirm no capture UI or stale selection outline appears in the image.
3. Verify the clipboard image dimensions in Preview and another chat app. Compare text pixels with the source, including transparent PNGs, thin borders, and small selected rows. Browser/receiving-app compression is outside this export contract.
4. Exercise Escape, closing/reloading/quitting during capture, chat/child switches, leaving and returning to the same target, shortcut conflicts, and pending attachment copies. No capture may land in a different draft or erase typed text.
5. Change defaults, restart, edit old captures, delete history while an independent attachment exists, and exhaust history limits. Check light/dark themes, keyboard-only operation, sound off, and reduced motion.

Exact component recognition across other apps, an accessibility-tree adapter, browser DOM access, cross-platform native desktop snipping, and a single Smart area overlay spanning multiple displays remain follow-up work. External Smart area is bounded visual-boundary assistance; it cannot guarantee HTML element boundaries, remove composited wallpaper, or recover occluded pixels.
