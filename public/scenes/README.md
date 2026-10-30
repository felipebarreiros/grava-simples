# Scene artwork

The standard scene cards use the approved original GravaSimples recording companion in a charcoal acoustic-panel studio with warm orange lighting. The studio images were generated with the built-in imagegen tool and are served locally as optimized WebP assets.

| Asset | Use |
| --- | --- |
| `mascot-concept.webp` | Shared camera-layer image for Principal, camera zoom, camera + screen and cropped camera frames. |
| `presentation-studio.webp` | Matching studio with the mascot shifted right so the standard presentation slide clears its head. |
| `presentation-slide.webp` | Static 4:3 ivory/orange sample slide for the presentation card, rasterized at 960×720 from the repository's `ScreenArtwork` SVG composition. |
| `countdown-studio.webp` | Matching studio backdrop with a small mascot at the edge and quiet space for the countdown card's editable title and clock. |

The mascot uses an orange rounded-square shell, a charcoal face, warm ivory pill eyes, a small smile, nub arms, oval feet and an offset recording indicator. It has no flame silhouette or pixel grid. The current character is raster artwork; its simple forms support a future native SVG implementation with blinking, waving and subtle idle movement.

Scene cards compose these images in SVG alongside native ivory/orange editorial screen graphics and editable text. Layer visibility, order, frames, camera shape/border, zoom and text styling remain configurable. Thumbnails stay static: they request no capture permissions, sample no live video and run no animation or ticking timer. These assets do not replace actual camera sources, change live previews or appear in recordings. Project covers continue to use real composed stills.

The presentation sample slide is generated from existing code, without AI imagery. Its raster image avoids seams when the browser clips the static thumbnail into perspective slices; live presentation content still comes from the selected project source.

Mascot prompt summary: preserve the approved 16:9 dark studio and orange glow; replace the presenter entirely with one original, cute, nonhuman recording companion using simple vector-friendly shapes and restrained soft shading; no human traits, text, logos, flame shape or pixel grid. The full mascot prompt and lossless original are retained in `.context/mascot/prompt-v1.txt` and `.context/mascot/concept-v1.png` in the working workspace.

Countdown prompt summary: retain the approved mascot's identity and studio palette; place the character smaller at the edge of the scene and leave calm charcoal space for separately rendered title and timer, with no text or clock baked into the image.

Presentation prompt summary: preserve the approved studio, mascot size, vertical position and pose; shift only the mascot to the right, leaving the left 45% clear for the slide. Created with the built-in imagegen tool; full prompt retained in `.context/mascot/presentation-prompt.txt`.
