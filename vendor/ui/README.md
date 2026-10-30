# UI component source provenance

The repo-owned components under `src/components/ui` adapt the official shadcn/ui New York registry component structure, variants and Radix compositions fetched from https://ui.shadcn.com/r/styles/new-york/{button,input,textarea,switch,slider,tooltip}.json on 2026-10-30. MIT license is preserved in SHADCN-LICENSE.txt.

This application uses ordinary CSS. Tailwind utility class strings and the class-variant utility are translated into equivalent shared studio token classes and a small variant lookup in kit.css/button.tsx; the shadcn Radix composition and native prop contracts remain visible in the component source. No claim of an unmodified shadcn CLI install is made. `NumberInput` adds clearable numeric draft handling; `Tooltip` is a convenience wrapper around the original primitives.

Tabs, dialogs, dropdown/context menus, alert dialogs, and single-selection toggle groups are composed directly from their official Radix primitives and use the same studio CSS tokens. Their wrappers retain Radix's keyboard navigation, focus management, state attributes, and prop contracts.

Layer reordering uses dnd-kit core/sortable with pointer and keyboard sensors, rather than a handwritten sortable list. Canvas position/resize handles use native pointer capture for accurate coordinates in the existing video canvas.
