# Scene editor · 0.4.0

The studio follows [STYLE_GUIDE.md](STYLE_GUIDE.md): neutral charcoal surfaces, orange actions, Portuguese labels, a quiet canvas, and a generic flame icon. Shared controls use repository-owned shadcn/ui-derived source adapted to CSS tokens, with Radix for behavior and dnd-kit for sortable layers. This is documented source adaptation, not an unmodified Tailwind/shadcn CLI installation; provenance and MIT notices are in vendor/ui.

## Shared controls

Project tabs and search category tabs use Radix Tabs with visible focus and associated panels. The header uses one breadcrumb trail with matched project/section controls and slash separators, rather than a separate tab capsule. The project name opens a Radix menu with Copy project link and Rename project; only Rename opens the name editor. Copy provides success/failure feedback and creates a clean project URL. Responsive truncation keeps navigation and recording controls in one row. Project panels remain mounted so switching tabs preserves the preview canvases. Project three-dot/right-click actions, layer creation, modal dialogs and delete confirmations use shared Radix primitives. Camera shape, text alignment, orientation and color choices use Radix selection groups.

Countdown duration offers 1, 3, 5, 10 and 15 minutes or a custom minutes field. Values still persist as seconds; existing non-preset durations open as Custom without changing them. Changing the duration pauses/resets the clock; selecting Custom only reveals the field.

## Editor behavior

The inspector follows the selected scene and layer. Repeated layer kinds are allowed. The top-first layer list supports drag handles, keyboard sorting, duplication, visibility, removal, and explicit up/down actions. Selecting the canvas or list synchronizes selection. DOM overlays provide pointer movement, eight resize handles, keyboard nudges and aspect-preserving corner resize. These controls never enter recorded canvases.

Horizontal and vertical geometry are independent normalized frames. The inspector exposes position, size, framing reset, text content/font/color/alignment, camera shape/outline thickness/shadow, and source replacement. Physical camera choice applies to the scene's camera feed; copies of that feed may appear in multiple layers. Per-layer screen/media replacement changes only that binding. Uploaded media is durable locally; a screen stream remains a session grant.

Microphone mute, gain and device choice belong to the scene. Settings are restored before its output is shown, and physical-device changes during recording are blocked explicitly. The local mute notice watches sustained input level before software mute, throttles repeats, and offers a clear unmute action. It does not recognize speech or send audio anywhere.

## Countdown and diagrams

CountdownPainter provides cached charcoal/orange artwork, balanced headline wrapping and stable digit advances in a quiet timer panel. Multiple title/timer layers support styling and positioning. The clock starts paused; changing/resetting duration pauses; zero is valid; Reset restores configured duration while paused; Zero stops atzero; Start explicitly runs a nonzero remaining clock. No scene selection, reset or background load starts the clock implicitly.

Scene cards are static SVG layout diagrams driven by layer geometry, visibility and text. They do not acquire camera frames, tick timers, or schedule refreshes. Real project cover stills remain. This removes the distracting sampled-preview motion and its recurring work.

The collapsible sidebar animates width while preserving icon alignment and row height. Hover/focus tooltips identify collapsed actions and project names. Three-dot/right-click project actions remain available. The storage caption has been removed.

The customer view assumes sign-in; Clerk remains deferred. Quality controls remain in Preferences, while technical diagnostics stay behind About. Media engine and qualification limits are unchanged: partial OBS components, browser capture/encoding, no full libobs/plugin runtime, and sustained1080p30/one-hour/4K60 still unqualified.
