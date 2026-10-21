# Changelog

Notable changes to Keyline. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses semantic versioning once it publishes releases.

## [Unreleased]

### Added

- **On-canvas text editing, slice 2.** Text is now something you type, not only restyle. The
  editing surface is a real `<textarea>` overlaid exactly on the object, so the caret, drag
  selection, word/line keys, clipboard, IME composition and screen-reader access are the
  browser's rather than a re-implementation. Placement is one testable function,
  `textEditorPlacement` in `src/core/text-edit.ts`, which composes the viewport with the
  object transform and returns the matrix, box, font, line height, alignment and ink the field
  paints with; the overlay follows pan and zoom through a viewport revision, so the caret stays
  on the glyphs. The renderer stops painting the edited object's glyphs
  (`RenderOptions.editingTextObjectId`), so the string is never drawn twice. Edits write through
  the existing `UPDATE_OBJECT` inside one transaction, so frames, the inspector's measured box
  and export follow while you type and the whole session is **one undo step**. New **Text tool**
  (`T`) creates an object at the pointer and opens the field, so the first keystroke is the
  text; double-clicking a text object with Select opens it with the caret at the end; **More →
  Add text** and the command palette now end in a caret too. `Enter` adds a line, `Tab` commits
  and moves focus on, `Escape` and ⌘/Ctrl+Enter commit — reversible with one Undo. Not yet:
  wrapping, auto-size, several styles in one object, text on a path, text stroke, or editing the
  style inside the field.
- **Text objects, slice 1.** Text is now a document object: `NetworkObject.text` carries content
  and style, layout lives in `src/core/text.ts`, and because text is an ordinary object, layers,
  selection, hit testing from its box, transform, opacity, duplication, undo and the document
  snapshot all apply with no new paths. Lines are measured by a canvas-backed metrics provider
  in the app and a deterministic fallback in tests, and nothing measured is persisted, so a file
  is laid out in the fonts of the machine that opens it. Add text from **More → Add text** or the
  command palette; edit content, family (sans/serif/mono), weight, size, line height and
  alignment in the Design panel. Text fills take solid or gradient paint, exports as SVG `<text>`
  with a `<tspan>` per line, and imports back as editable text with warnings for anything the
  model cannot carry (`textPath`, per-run styling, `letter-spacing`, `textLength`, unknown
  families, skewed transforms). The WebGL preview falls back to Canvas 2D when a document
  contains text, so text is never invisible. Not yet: a text tool, an on-canvas caret or
  selection inside text, wrapping, multi-run styling, custom fonts, text on a path, text stroke.
- **Gradient fills.** An object fill can now be a solid, a linear gradient or a radial gradient.
  `AppearanceFill` is a discriminated union in `src/core/types.ts`; gradient endpoints are stored
  **object-local**, the same space as nodes, so a gradient moves, scales and rotates with its
  shape and appears on every occurrence of a parametric repeat without extra work. Stops
  (`offset`, `color`, `opacity`) are sorted and clamped by `normalizeStops`, every clone goes
  through `cloneFill`/`cloneFills` so a copy cannot share a stops array, and a gradient can never
  have fewer than two stops. The Design panel's fill row gains a Solid/Linear/Radial switch, an
  angle or radius field, and a stop editor; the Canvas renderer builds a real `CanvasGradient`;
  SVG export writes `<linearGradient>`/`<radialGradient>` in `<defs>` with
  `gradientUnits="userSpaceOnUse"`, `stop-opacity` per stop and a matching `fill="url(#…)"`, so
  the round trip keeps the gradient.
- **SVG import reports what it cannot draw, instead of losing it silently.** `url(#…)` fills now
  resolve against `linearGradient`/`radialGradient` definitions, including `href`/`xlink:href`
  inheritance and `objectBoundingBox` units converted with the shape's own box.
  `gradientTransform` is composed onto the endpoints. Everything the model cannot express — a
  pattern fill, a missing gradient id, a non-pad `spreadMethod`, a radial focal point, a skewed
  gradient transform, a filter, mask or clip path on an element, a fill on an open path —
  produces a structured `SvgImportResult.warnings` entry (`{ code, message, element? }`). The
  import receipt names the first warning and counts the rest, and the tidy dialog shows the
  count before the file opens.
- **Frame presets for real work, not just icons.** The New frame menu is now grouped — Interface
  (24/32/48), Web (1440 × 1024, 1280 × 800), Device (390 × 844, 768 × 1024), Social (1080 × 1080,
  1200 × 630), Print (A4 and US Letter at 96 dpi, stated as such) and Artwork (1000 × 1000,
  1920 × 1080) — plus the existing custom size. `src/core/frame-presets.ts` is the only list; the
  menu, the command palette, the dashboard and the in-canvas start all read it, so they cannot
  drift. Frames from a non-icon preset are named after it (`Web page`, `Social post`) and numbered
  when duplicated; icon frames keep their `Icon N` naming.
- **A neutral empty state.** The dashboard opens with **New file**, a blank canvas (1440 × 1024) and
  a social post beside the icon set and logo starts, and its copy no longer assumes icons. The
  in-canvas start overlay offers the same general sizes next to the icon one. Everything
  icon-specific — the icon-set view, pixel grid and icon exports — remains, as an option.
  Drawing outside every frame already landed on the page-level canvas root; that behaviour is now
  pinned by a test.
- **Direct path editing.** Double-click a segment in point editing to insert an anchor exactly
  where the pointer meets the curve — the curve does not move, because the insert is the same
  exact split the Cut tool uses (a cubic splits into two cubics, an arc keeps its radius and
  sweep) — and the new anchor is selected, so the next drag moves it. Hovering a segment shows a
  hollow square where that anchor would land. `⌥`-drag a corner anchor to pull a tangent pair out
  of it as one undo step.
- **Corner conversion derives its tangent.** `Sharp` / `Smooth` / `Mirrored` in the inspector now
  do more than record a mode: converting to smooth or mirrored writes a tangent pair derived from
  the anchor's neighbours, in the same undo step as the mode. Sharp leaves the handles alone.
  The three mirroring modes are pinned by tests for the first time (`angle` mirrors direction,
  `mirror` mirrors direction and length).
- **Hover previews.** Pointing at the canvas now outlines what a click will select: a dashed
  outline for a group and a solid hairline for a shape, drawn as a light preview that never reads
  as the persistent selection. Hover and press resolve through one pipeline
  (`src/core/target-resolution.ts`), so the preview obeys paint order, the group you have entered,
  and the document's visible/locked state; anchors, segments and Bézier handles preview only while
  their path is being edited. Hover never writes to the document or the selection, and the preview
  clears when the pointer leaves the canvas, a dialog opens, the tool changes, or a drag begins.
- **`Alt`-click selects the parent group.** One click steps out one level, including from inside a
  nested group, and leaves the selection at that level. `Alt`-drag still duplicates — the two
  gestures are separated by movement, not by another modifier. Precedence is documented in
  `docs/EDITING-AUDIT.md` §3.5: path affordances, then `Alt`-click, then `Ctrl/⌘`-click cycling,
  then `Shift`-click, then a plain click.
- **Group entry and exit.** A click on grouped artwork selects the outermost group (every shape
  inside it, so the existing move/resize/rotate/delete paths apply unchanged). Double-click descends
  one nested level, a banner names the group you are inside, and `Escape` or **Exit group** steps back
  out one level with the group still selected. Clicking artwork outside the group leaves it. Unlike
  isolation, entering a group hides nothing. The contract lives in `src/core/group-context.ts` and is
  pinned by `src/core/group-context.test.ts`.

### Changed

- Hover resolution was measured, not assumed: 60 resolutions on a 2000-object document take a
  1.4–1.6 ms median in Node (`src/core/target-resolution.test.ts`), down from 56 ms. The gain came
  from scoping hit tests to the candidate object, memoising bounds in `src/core/bounds-cache.ts`,
  and caching object→layer lookups against a document revision counter that every mutator bumps.
  This is the resolution step only; a browser frame-time benchmark is still outstanding.

- **Every enabled control in the right panel is now tested to reach the document.**
  `src/ui/panel-controls.test.tsx` renders the inspector in nine states — object, hidden
  object, multi-selection, frame, point editing and seventeen tool sections — clicks and types
  into every control that is not disabled, and fails if that control neither mutates the
  document nor calls its callback with a payload. The callbacks it wires mirror `App.tsx`,
  including its editability rule, so a control the app would silently drop cannot pass.

### Fixed

- **A hidden shape kept a fully enabled inspector whose edits went nowhere.** Hiding a layer
  removed it from hit testing, but every inspector handler also refused hidden objects, so
  position, size, rotation, fills and stroke changes were discarded without a word: the panel
  looked live and the document never changed. Hiding is a view state, so the editability rule
  in `src/app/inspector-actions.ts` is now lock-only, shared by `updateObject`,
  `updateAppearance`, `updateObjects` and `updateObjectAppearances`, and matched by
  `prepareFlipObjects`. Locked shapes remain read-only and keep their notice.
- Clicking now selects the shape that is actually painted on top. Hit testing walked objects in
  insertion order while the renderer paints in layer order, so after reordering a layer the click and
  the picture disagreed. Both now resolve through one paint order.
- `Ctrl/⌘`-click cycles down through every shape under the pointer (and wraps), so an object hidden
  behind another no longer requires a trip to the Layers panel.

- Inspector controls that could never run now say why in their tooltip (frame rotation, frame flips,
  frame corner radius, `Clip content`, distribution with fewer than three layers, arrangement with
  fewer than two) instead of reading as broken buttons.
- A frame holding exactly one shape can now be aligned: the alignment row was gated on two or more
  frame contents, even though aligning a single shape to its frame is well defined. Availability is
  now derived from the same visible-and-unlocked set the commands act on, so an enabled control always
  changes something. Distribution also skips objects it would not move, so it never opens an empty
  transaction.

- Rotating from the inspector (the `Rotation` field, the 90° button, or `R°` on a multi-selection)
  now turns the selection about its centre. It used to write the angle straight into the
  transform, which rotates about the object's local origin — usually a corner — so a single
  typed angle could throw a shape out of its artboard.
### Added

- `docs/PRODUCT-AUDIT.md` — the product measured against the full P0–P5 plan: a feature matrix with
  source evidence, the gap report in dependency order, and the recommended next milestone.
- `docs/EDITING-AUDIT.md` — a line-by-line audit of the interaction model (selection, transform
  handles, group entry, nudge, typography, gradients) with the smallest change set for each gap.
- **Recovery restore.** `.keyline.json` backups downloaded after a save failure can now be
  imported from the dashboard. Files are validated, opened as a new drawing named
  `<name> (restored)`, and never overwrite the original document.
- `docs/` — architecture, user guide, development, testing, collaboration, FAQ, audit and
  hand-authored diagrams.
- `CONTRIBUTING.md`, `SECURITY.md`, this changelog, and an MIT `LICENSE`.
- `.github/workflows/ci.yml` — build, strict TypeScript, unit/integration tests, Wasm smoke
  test, WebSocket relay suite, Rust tests and documentation checks.
- `npm run check:docs` — validates relative documentation links, required files, tracked
  artifacts, and (with a Vitest report) the published test counts.
- `.gitattributes` for consistent line endings and binary handling.

### Changed

- Selected objects now show a quad frame with eight square resize handles and a `W × H` readout that
  turns with the selection and flips to the top edge rather than rendering upside down. Drag a handle to resize
  (`Shift` keeps the aspect ratio); hover just outside a corner to get a rotate cursor and drag to
  rotate (`Shift` snaps to 15°), the way Figma does it — no separate handle. The frame follows the
  object's own axes, so both gestures are exact at any angle, and each drag is one undoable step.

- Arrow keys now nudge selected objects (1 px, `Shift` 10 px) as one undoable step, not only
  points in edit mode.
- The wheel pans the canvas (plain scroll, `Shift` for horizontal) while `Ctrl/⌘` + wheel or a
  pinch zooms at the pointer; `Ctrl/⌘ +` and `Ctrl/⌘ -` step the zoom.
- The top bar, status bar and inspector share one docked-chrome surface, so the right panel no
  longer sits one ramp step away from the bars beside it.

- README rewritten as a landing page: what it is, quick start, feature map, documentation index,
  repository map, quality gates and an honest limitations list.
- Package metadata now identifies the project as `keyline`, with description, license,
  repository, bugs and homepage fields.
- `npm run check` now includes the documentation check.
- Solver descriptions refer to Keyline instead of the internal working name.

### Fixed

- The repository had no `.gitignore`, so `node_modules/`, `dist/`, audit output and caches were
  untracked only by luck.
- Generated TypeScript build caches (`tsconfig.*.tsbuildinfo`) and `vite.log` were tracked; they
  are now removed and ignored.
- The save-failure recovery download had no import path, so the offered backup could not be
  restored.
- Documentation links and test counts are now verified instead of maintained by hand.

### Removed

- Tracked build artifacts (`tsconfig.app.tsbuildinfo`, `tsconfig.node.tsbuildinfo`, `vite.log`).

## [0.1.0] — 2026-10-20

Initial source publication of the editor.

### Features

- Typed vector document: nodes, line/Bézier/**native arc** segments, paths, derived regions,
  constraints, parametric groups, appearance, objects, layers, artboards and pages.
- Eleven constraint types with hard/medium/soft priorities, deterministic solving, conflict
  diagnostics and rollback.
- Two solvers: synchronous TypeScript preflight and a Rust/WebAssembly verifier in a worker.
- Drawing tools: select, pen, pencil, brush, primitives, construction lines, native arcs, shape
  builder, cut, bend, fillet, offset, variable width, region paint, lasso, eraser with healing.
- Pixel grid, numeric expressions, corner radii, frame presets and one-shot frame arrangements.
- Local dashboard with search, filters, rename, duplicate, undoable delete and thumbnails.
- Icon-set view with search plus consistency checks for stroke width, line ends, safe area,
  half-pixel alignment and minimum readable stroke.
- Geometry families with source/variant topology, propagation previews, overrides, conflict
  choices and family QA with undoable fixes; shared appearance rules.
- SVG import with optional tidy rules and a preview.
- Export: SVG (artboard/artwork bounds, optional background), PNG at 1×/2×/3×/custom, batch ZIP
  with naming patterns and presets, React + TypeScript component, CSS variables, export
  variables and a family change manifest.
- Motion export to self-contained animated SVG with CSS keyframes.
- Local-first collaboration over Yjs with offline sync, presence, canonical replay and separate
  local file identity.
- Canvas 2D and batched WebGL2 renderers behind one switch, with automatic fallback.
- IndexedDB autosave with revision-aware serialization, lifecycle flushes and a downloadable
  recovery snapshot; snapshot versions 1–6 load with migration.
- Deterministic on-device command bar with appearance phrase editing (no AI model).
- Accessibility work: focus containment, labelled controls, contrast fixes, reduced motion.

### Verification at publication

318 tests across 57 files, a real Wasm artifact smoke test, nine WebSocket integration checks,
Rust unit tests, and browser suites recorded in [docs/AUDIT.md](docs/AUDIT.md). Browser suites
require a Playwright session and are not part of CI.
