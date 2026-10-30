# GravaSimples interface and editor guide

The product is a Portuguese recording workspace with warm charcoal surfaces and Hotmart-inspired orange accents. The generic flame icon is a studio mark; do not trace or embed Hotmart's brand logo. Preserve a quiet main canvas and generous spacing. Avoid technical labels, status footers, and repeated explanations in the normal recording flow.

## Shared controls

Use repository-owned shadcn/ui-derived primitives in `src/components/ui`, with Radix behavior and the shared CSS tokens. Inputs, numeric fields, sliders, switches, buttons, selects, tabs, dialogs, menus, selection groups, and tooltips must use these components. Project navigation and search filters use Radix Tabs with keyboard navigation and associated panels. The project header is one breadcrumb trail: project index, project name menu, and section tabs share typography, sizing, and quiet hover/selection treatments. Section tabs have no separate enclosing capsule. The project menu offers Copy project link and Rename project; copying uses the active project hash and omits query parameters, while editing opens only after its explicit menu action. Long names truncate and controls compact at smaller widths. Project actions and the add-layer menu use Radix dropdown/context menus; destructive confirmations use AlertDialog. Camera shape, text alignment, orientation, and color swatches use Radix selection groups. Keep icon actions compact; primary actions use orange, secondary actions neutral charcoal. Switches use normal horizontal geometry and consistent focus rings. Numeric drafts may be empty while editing and commit valid zero where supported.

All interactive controls need Portuguese accessible names, visible keyboard focus, consistent hit areas, and meaningful disabled states. Menus must dismiss with Escape and restore focus. A nested select closes before its parent dialog. Reduce or remove motion when the OS requests reduced motion.

## Authentication and account controls

Keep Clerk's native components and configure their shared appearance in
`src/auth/appearance.ts`. Match the studio's DM Sans, neutral charcoal surfaces,
orange action color, and 8px control corners. Authentication forms use a readable
16px body, 14px labels, 28px heading, and 48px primary/social controls. The desktop
form is 448px wide and contracts naturally on phones; short screens scroll
instead of shrinking the text.

Set Clerk's typography and spacing explicitly. Its default rem values inherit
the studio's compact 14px root and otherwise shrink body text to about 11px.
Scope form width to sign-in/sign-up components, retaining Clerk's viewport limits
for account dialogs. The generic application input reset excludes `.cl-input`
so it does not override Clerk's form, OTP, or hidden input geometry.

Use filled neutral social actions, a clear field boundary, and a visible card
edge. Keep the footer on the same charcoal surface and retain Clerk's branding
and development notice. Review the complete login page and account dialog at
desktop and 320/390px phone widths; passing color ratios alone does not establish
readable sizing or visual consistency.

## Navigation

Collapsing the sidebar animates its width, preserves icon positions and row rhythm, and keeps every navigation action accessible. In the collapsed state, hover/focus reveals a tooltip with the full action/project name. The redundant local-storage caption is absent. Project actions remain available with three dots and right-click.

## Scene and source behavior

The selected scene owns microphone mute, gain, microphone choices, layers, text, style, and geometry. Switching scenes must restore that scene's audio without changing other scenes. The project owns reusable camera, display and media sources, including their names and camera device choices. Standard camera scenes share a camera; **Câmera + tela** and **Apresentação** share a display. Switching between those scenes changes the composition without reopening a browser chooser.

Show available inputs under **Fontes do projeto** in the source picker. Reusing one changes only the selected layer's binding and preserves its geometry; adding another camera, screen/window or media file creates a distinct source. Reconnecting an offline source keeps its identity and updates every referencing scene. Multiple layers of one kind remain independently editable and may reuse the same source or select different sources. Source permissions are requested from user actions; an existing camera grant may be reused automatically without a new prompt. Saved source identities never authorize an automatic display chooser, and leaving the project releases its live captures.

Layer order follows visual stacking. Pointer and keyboard sorting use dnd-kit; selecting a layer in the list selects it on the canvas and vice versa. The canvas editor displays selection/resize handles over the actual output, without recording those controls. Position and size are normalized and saved independently for horizontal and vertical output. Camera/screen proportions stay correct unless the user explicitly chooses a crop/shape.

## Scene previews and countdown

Scene cards use static photo-backed SVG compositions. Camera layers share the approved original mascot and charcoal/orange studio image at `/scenes/mascot-concept.webp`; zoom scenes crop that image. Screen layers use an ivory editorial slide with an orange sculptural motif. The countdown card uses `/scenes/countdown-studio.webp`, keeping a small mascot at the edge of the matching studio so the editable title and clock remain clear.

Thumbnail composition follows the scene's current layer visibility, stacking, normalized frames, camera shape and border, zoom, text and styling. **Apresentação** uses a large 4:3 sample slide tapering toward the presenter on the right. Its vertical output places a flat, full-width slide above the camera; the split follows the actual slide aspect ratio. Cards request no capture permissions, sample no live video, tick no timers and add no recurring render work. The mascot is currently raster artwork; a native SVG character and animation are future iterations. These card graphics do not change live camera previews or recorded output. Project covers may retain actual captured stills.

Countdown duration offers 1, 3, 5, 10, and 15 minute presets plus a custom minutes field (including zero and fractional minutes). Stored seconds and previously saved durations remain compatible. Selecting a duration pauses and resets the timer; choosing Custom alone preserves its current duration.

The countdown uses the dedicated Canvas painter with high-contrast type, fixed digit advances, balanced portrait line breaks, cached charcoal/orange artwork, and a restrained timer plaque. It starts paused, accepts zero, and reset returns to configured duration while paused. Explicit Start is the only way to begin/resume. Uploaded backgrounds, duplicate text layers, font size, and manual placement remain functional.

## Audio alerts

Mute warnings react to sustained pre-mute microphone signal locally, with a cooldown and a clear unmute/dismiss action. They are a signal heuristic, not speech recognition. The raw analysis path must never bypass mute into a recording. Alerts are overlays in the application and must not appear in recorded canvases.

## Verification

Review both 16:9 and 9:16 outputs, expanded/collapsed navigation, modal controls, keyboard interactions, and the actual saved video pixels/audio. A visually attractive inspector is insufficient if its controls do not affect the output. Keep codec/export regressions and source archives intact. Do not claim full libobs, sustained 1080p30, or 4K60 qualification from short functional tests.
