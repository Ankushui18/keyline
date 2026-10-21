# Editing audit

What the editor does today when someone selects, moves and edits a shape, what it
does not, and the smallest set of changes that closes the gap with a conventional
vector editor — without touching the document model, the solver or the tests that
protect the geometry.

This is an audit, not a roadmap. Every claim below is tied to the line it comes
from, so it can be checked rather than trusted.

---

## The short version

**Verdict: evolve the current architecture. Do not refactor it.**

The engine is not the problem. `OperationManager` already routes every edit
through 68 typed operations (`src/core/operations.ts`), each with an inverse, and
the renderers, exporters and collaboration layer all read the same document. That
is the hard part of a vector editor and it is already built and tested.

The gap is the layer above it: **how pointer input becomes a selection, and how a
selection becomes an edit**. Today that layer is thin in exactly the places a
designer notices first — objects have no resize or rotate handles, groups cannot
be selected on the canvas, and arrow keys only nudge after you have entered point
editing. Those are UI decisions, not model decisions, and each can be added
against the existing operation vocabulary.

A rewrite would put the geometry engine, the solver contract, the exporters and
the 300+ tests at risk to change code that is not the bottleneck.

---

## 1. How editing works today

Selection has exactly two modes (`src/core/types.ts:437`):

```ts
export interface SelectionState {
  mode: SelectionMode;          // 'object' | 'network'
  objectIds: Set<EntityId>;     // whole shapes
  editingObjectId?: EntityId;   // the shape whose points are being edited
  nodeIds: Set<EntityId>;       // points
  segmentIds: Set<EntityId>;    // segments
}
```

| Transition | Trigger | Where |
|---|---|---|
| select object | click on a shape (`hitTestObject`) | `src/tools/select-tool.ts:87`, used at `src/canvas/VectorCanvas.tsx:643` |
| edit points | `Enter`, or double-click a selected object | `src/canvas/VectorCanvas.tsx:621` |
| leave point editing | `Escape`, or select something else | `src/canvas/VectorCanvas.tsx:453` |
| marquee select | drag on empty canvas | `src/canvas/VectorCanvas.tsx:1147` |
| move objects | drag inside the selection bounds | `src/canvas/VectorCanvas.tsx:1704` |
| resize artboard | drag one of 8 handles | `src/canvas/VectorCanvas.tsx:1103` |
| pan | middle-drag, `Space` + drag, wheel | `src/canvas/VectorCanvas.tsx:659`, `src/canvas/viewport.ts` |

Two design choices in that table are deliberate and should be kept:

- **Hit testing prefers geometry.** A thin path is clickable along its stroke
  before the bounding-box fallback is considered (`select-tool.ts:87-118`).
- **Gestures are transactional.** A drag opens a transaction only after 2 px of
  movement (`VectorCanvas.tsx:1705`), so a click never leaves a history entry.

---

## 2. Behaviour matrix

Compared with what a Figma user expects. "Evidence" is where the behaviour lives,
or where it would have to be added.

| Behaviour | Today | Evidence | Verdict |
|---|---|---|---|
| Click selects a shape | yes, topmost under cursor | `select-tool.ts:87` | works |
| Marquee select | yes, additive with `Shift` | `VectorCanvas.tsx:1147` | works |
| Drag to move | yes, `Alt`-drag duplicates | `VectorCanvas.tsx` `handlePointerDown` → `move-object` | works |
| Hover previews the target a click will select | yes — one resolver (`resolvePointerTarget`) feeds hover and press; groups preview dashed, shapes solid, path points only while that path is being edited | `core/target-resolution.ts`, `drawHoverTarget` in `canvas/renderer.ts` | **shipped in this pass** |
| `Alt`-click selects the parent group | yes — steps out one level, including from inside a nested group, and leaves the selection at that level; `Alt`-drag still duplicates, separated by movement | `parentGroupTarget` in `core/target-resolution.ts`, `VectorCanvas.tsx` `handlePointerUp` | **shipped in this pass** |
| Arrow-key nudge, objects | yes, 1 px / `Shift` 10 px, one undo step | `App.tsx:1843`, `core/object-operations.ts:253` | **added in this pass** |
| Arrow-key nudge, points | yes | `App.tsx:1871` | works |
| Drag a corner to **resize** an object | yes — eight square handles on a frame drawn on the object's own axes, `Shift` keeps the ratio, one undo entry per drag | `src/core/object-resize.ts`, `renderer.ts:1102` | **shipped in this pass** |
| Size readout while selected | yes — `W × H` pill outside the frame, rotated with it but never upside down, hidden when the selection is too small to fit it | `drawSelectionSizeBadge` in `renderer.ts` | **shipped in this pass** |
| Rotate | yes — hover just outside a corner for a rotate cursor, drag to turn, `Shift` snaps to 15° (no handle, as in Figma) | `frameHitTarget` / `prepareRotateObjects` in `src/core/object-resize.ts` | **shipped in this pass** |
| Rotate by number | yes — the `Rotation` field and the 90° button turn about the frame centre, so typing an angle never moves the shape | `prepareRotateTo` in `src/core/object-resize.ts` | **fixed in this pass** |
| Double-click a shape | enters point editing (also `Enter`) | `VectorCanvas.tsx:621` | works |
| Double-click **enters a group**, `Escape` leaves one level | yes — a click selects the outermost group, each double-click descends one level, `Escape` steps out and keeps the group selected | `core/group-context.ts`, `canvas/VectorCanvas.tsx` | **shipped in this pass** |
| `Ctrl/⌘ G` / ungroup | only when a layer row has focus | `ui/LayersPanel.tsx:452-500` | partial |
| Layers: nest, reorder, lock, hide | yes, full keyboard reordering | `ui/LayersPanel.tsx:121-186` | works |
| Isolate a group | yes, but it **hides** the rest of the document | `core/document.ts:317`, banner at `VectorCanvas.tsx:2285` | partial |
| Multi-artboard documents | yes; frames come from one grouped preset list (Interface, Web, Device, Social, Print, Artwork) plus custom size | `core/frame-presets.ts`, `ui/Toolbar.tsx` frame menu | **general-purpose since this pass** |
| Text objects | **absent** — no text tool, no text entity in `src/core/types.ts` | — | **missing** |
| Gradients | **absent** — fills are solid only; `core/document.ts:1110` records the old union advertised gradients without a model | — | **missing** |
| SVG import / export | yes, with round-trip tests | `src/import/svg-import.ts`, `src/export/svg-export.ts` | works |
| Undo granularity | one entry per completed gesture, one per key nudge | `VectorCanvas.tsx:1705`, `operations.ts` | works |
| "Ask for an edit" | deterministic phrase → appearance change, no model | `src/core/quick-edit.ts:71` | seed for AI |

---

## 3. The four gaps that matter, in order

### 3.1 Object resize handles — done

A selected object used to draw a plain box (`renderer.ts:1102`) with no handles,
so a press on a "corner" started a *move*: the box promised something the editor
did not do.

Now the frame carries eight handles, drawn in the canvas at the same positions
they are hit tested (`src/core/object-resize.ts`), with a `resize-object` gesture
next to the existing artboard one. A drag commits ordinary `UPDATE_OBJECT`
transforms inside one transaction, so it undoes, autosaves and collaborates like
every other edit, and geometry is never rewritten.

Behaviour worth knowing: **`Shift`** on a corner keeps the selection's aspect
ratio, and the frame follows the object's own axes, so handles stay on a rotated
shape instead of boxing it.

### 3.2 Group entry and exit — done

`hitTestObject` returns the leaf object, so a click inside a group used to grab the
leaf whatever the user could see grouped. The Layers panel could select and group
layers, but the canvas could not address a group at all.

Group navigation now lives in `src/core/group-context.ts` and is expressed as one
selection field plus four pure functions:

- `SelectionState.groupContext` is the group the canvas is inside. Absent means the page
  root. It is a *selection* context, not the existing layer isolation — nothing is hidden.
- `selectionTargetForObject` resolves a hit to the outermost group containing it, or to
  the direct child of the entered group once you are inside one. A group target carries
  every visible descendant object, so move, resize, rotate, delete and undo keep using
  the existing multi-object paths instead of a new group transform node.
- `groupToEnterOnDoubleClick` descends exactly one level per double-click, so nested
  groups are walked a step at a time and a double-click on a leaf stays point editing.
- `exitGroupContext` leaves one level per `Escape` and keeps the group selected.
- `resolveObjectPress` is the single press decision the canvas calls: it returns the
  selection *and* whether the press descended into a group. A press that lands outside
  the entered group drops the context first, so a click can never select a child of a
  group the user is not inside.

An on-canvas banner names the entered group and offers `Exit group`, matching the
existing isolation banner; the Layers panel highlights the entered group instead of its
members while you are inside it.

The contract is pinned by `src/core/group-context.test.ts` (11 tests) and was written
before the code. Known limit: deleting a group selection removes its objects but leaves
the empty group layer behind.

### 3.3 Rotation — done

Rotation lived only in the transform (`types.ts:257`) and a number field
(`PropertiesPanel.tsx:1508`). It is now a gesture with **no handle**: as in Figma,
moving the pointer just outside a corner past the resize square turns it into a
rotate arrow, and dragging turns the selection about the frame centre. `Shift`
snaps to 15°.

That choice is deliberate. A drawn rotate control has to live somewhere — it was
tried above the top edge — and it either competes with the corner handles for
space or drifts off small shapes. The hover zone costs no pixels, works at any
zoom because it is measured in screen distance, and is the interaction designers
already know.

Snapping differs by selection on purpose. One object snaps its *absolute* rotation
onto the grid, so "make this 45°" is reachable by dragging. A multi-selection snaps
the *applied delta*, because the objects do not share an angle to snap.

This also removed the approximation in 3.1: the frame is now a quad on the object's
own axes, so a single object resizes and rotates exactly at any angle. The only
remaining approximation is non-uniform resizing of several rotated objects at
once, where each object is scaled in its own axes — unavoidable while the
transform is `rotate × scale` rather than a general matrix.

### 3.4 The inspector's unavailable controls now read as unavailable

The panel is denser than the interaction model behind it. With nothing selected it
shows 37 controls, and before this pass 16 of them were greyed out with the same
tooltip they carry when enabled — so a button that could never run was
indistinguishable from one that had failed to react.

Three rules now hold, and `src/ui/PropertiesPanel.states.test.tsx` enforces them by
rendering the panel in its frame, single-selection and multi-selection states:

1. **Availability is derived from the set the command acts on.** `canAlignObjects`,
   `canArrangeObjects`, `canDistributeObjects` and `editableObjectIds` in
   `src/core/inspector-layout.ts` measure visible, unlocked objects — the same set
   `alignmentUpdates` and friends move. A frame holding one shape can now be aligned
   to that frame; it used to be gated on two or more contents even though one shape
   aligning to its frame is well defined.
2. **Every disabled control states its reason** in `title`, via the `disabledReason`
   prop on `DesignIconButton`, `DesignNumberField`, `DesignAlignment` and
   `DesignFlow`. The tooltip reads `Align left — this frame has no visible, unlocked
   shapes to align`, not just `Align left`.
3. **Genuinely unbuilt capabilities stay disabled, but say so.** Frames stay
   axis-aligned, cannot be flipped, have square corners, and `Clip content` is not
   implemented by the renderer. None of those are bugs to "fix" by enabling the
   control; they are limits the panel now names.

`src/ui/panel-controls.test.tsx` covers the other half of the rule: a control that *is*
enabled must reach the document. It clicks and types into every enabled control in the object,
hidden-object, multi-selection, frame and point-editing inspectors plus seventeen tool sections,
and fails if the control neither mutates the document nor calls its callback with a payload. Its
handlers mirror `App.tsx`, including the editability rule, so a control the app silently drops
cannot pass.

That audit found one real dead path: hiding a layer removed it from hit testing, and every
inspector handler also refused hidden objects, so a hidden shape kept a fully enabled inspector
whose edits went nowhere. Hiding is a view state, so editability is now lock-only
(`src/app/inspector-actions.ts`), shared by the four inspector handlers and `prepareFlipObjects`.

The canvas root is the awkward case. It has no bounds, so a lone shape outside every
frame has nothing to align against, while two or more such shapes align to their
combined bounds. That distinction is expressed once, in `canAlignObjects`, rather
than re-derived in each inspector branch.

### 3.5 Hover previews resolve through the selection pipeline

Hover is not a second hit tester. `src/core/target-resolution.ts` answers one
question — *what will a click do here?* — and both the pointer preview and the press
read that answer:

- `resolveObjectTarget` turns a leaf object into the thing a click selects, honouring
  the current `groupContext`: at the page root a child previews its **group**, and
  inside an entered group the same child previews itself.
- `resolvePointerTarget` is the whole pipeline. In point editing it answers anchor,
  segment or Bézier handle first, because those are the finest targets; in object
  mode it answers object bodies only, so the outline never promises a smaller target
  than the click will take.
- `parentGroupTarget` is the `Alt`-click gesture. It steps out one level, never
  re-selects the group the selection is already in, and answers `undefined` at the
  root where there is no level to leave.

Hover state is render-only: `updateHover` writes refs, `drawHoverTarget` draws them,
and nothing in that path touches the document or the selection (asserted in
`src/core/target-resolution.test.ts`). Groups preview as a dashed outline, shapes as a
solid hairline, so a preview never reads as the persistent selection. The preview is
cleared when the pointer leaves the canvas, when a modal takes over
(`interactionBlocked`), when the active tool changes, and while a gesture is running.

**Measured, not asserted.** `target-resolution.test.ts` builds a 2000-object document
and times 60 hover resolutions after 5 warm-ups: **median 1.4–1.6 ms**, against a
16 ms frame. Earlier in this work the same query cost 56 ms and, before scoped hit
testing, 127 ms at 200 objects — the fix was to stop walking the whole scene per move
(`hitTest`/`hitTestObject` scoped to the candidate object) and to memoise bounds
(`core/bounds-cache.ts`) and object→layer lookups against the document's revision
counter, which every mutator bumps. These are Node timings for the resolution step
alone, not browser frame times; the browser benchmark is still outstanding, and no
claim beyond this measurement is made.

Modifier precedence, settled before wiring:

1. **Path affordances win** — anchors, segments and handles beat every body-level
   gesture while a path is in point editing.
2. **`Alt`-click** selects the parent group. It only fires when the pointer did not
   move, which is how `Alt`-drag keeps duplicating.
3. **`Ctrl/⌘`-click** cycles down the stack under the pointer (z-order).
4. **`Shift`-click** adds to or removes from the selection.
5. **A plain click** selects what the preview shows.

### 3.6 Direct path editing — done

Path editing is the point where the selection model stops describing boxes and starts
describing geometry, so its contract is written here before any of it is wired.

**Spaces.** Nodes, anchors and Bézier handles are stored in the edited object's
**local** space; the pointer arrives in **world** space. One conversion, the object's
transform and its inverse, sits at the boundary, and every path rule below is stated in
local space. Frames are axis-aligned, so this transform is a translation, a rotation and
a positive scale — never a reflection.

**The four affordances.** One resolver, `resolvePointerTarget`, already answers what is
under the pointer; path editing adds the last two rungs at the top of that ladder:

| Rung | Target | Only while | Click behaviour |
|---|---|---|---|
| 1 | Bézier handle | its node is selected | drag the handle; mirroring follows the node's mode |
| 2 | Anchor | the path is in point editing | click selects it, drag moves it and everything selected with it |
| 3 | Segment body | the path is in point editing | click selects it, drag bends it; **double-click inserts an anchor** |
| 4 | Pull out handles | a corner anchor in point editing | `⌥`-drag away from the anchor and its lines become curves, as one undo step |
| 5 | Object body | always | select the object or its group |

Hover is drawn from the same answer: anchors as squares, segments as a stroke highlight,
handles as diamonds with their tether, and — in point editing — a small hollow square on
the segment at the point where a double-click would insert an anchor. Nothing is previewed
that a click would not take.

**Inserting an anchor.** Double-clicking a segment body splits it at the point nearest the
pointer through the existing `SPLIT_SEGMENT` inverse, so the curve is unchanged by the
insertion: a Bézier insert is an exact cubic split, an arc stays an arc with the split
angle, a line stays a line, and a width profile is split proportionally. Insertion is one
undo step, lands in the same path, and the new anchor is selected afterwards.

**Corner conversion.** A node has one of three persistent `handleMode`s. Conversion is
`SET_NODE_MODES` and nothing else:

- `corner` — handles are independent (`⌥`-drag one alone).
- `smooth` — the opposite handle keeps its **length**, its direction mirrors.
- `symmetric` — the opposite handle mirrors length and direction.

Converting to `corner` keeps the handles where they are. Converting to `smooth` or
`symmetric` **derives** the pair from the neighbours, so the anchor's own shape change is
the only visible effect and the curve becomes tangent-continuous. Conversion is one undo
step and works on a multi-selection. The inspector already exposes the three modes
(`Sharp` / `Smooth` / `Mirrored`); this pass makes set-and-derive explicit rather than
leaving the tangent to whatever handles happened to exist.

**Mirroring while dragging.** The three modes are pinned by tests in this pass, because
they were previously only implied by the labels: `angle` mirrors the direction and keeps
the opposite handle's length, `mirror` mirrors direction and length, and an independent
handle leaves the opposite one untouched. Conversion sets the persistent mode; dragging
reads it.

**Refusals, stated in the interface.** Infinite construction lines cannot be split (the
operation already throws), native arcs keep their own specialist tools rather than being
bent by dragging, and a locked or hidden object offers none of the five rungs.

### 3.7 General-purpose drawing — done

Everything about this editor's defaults was decided for 24 px icons: the frame menu
offered three icon sizes, frames were all named `Icon N`, and every start card on the
dashboard opened an icon file. A designer drawing a page, a post or a print sheet had to
create an icon frame and then fight it. This section is the contract for the defaults that
come before any drawing happens.

**One list of frame presets.** `src/core/frame-presets.ts` is the only place frame sizes
are described. Each preset carries a group, a label, a size and — except for the icon
presets, which keep their existing `Icon N` naming — the name its frame is created with:

| Group | Presets | Purpose |
|---|---|---|
| Interface | 24, 32, 48 px squares | the existing icon workflow, unchanged |
| Web | 1440 × 1024, 1280 × 800 | page layout at 1× CSS pixels |
| Device | 390 × 844, 768 × 1024 | phone and tablet |
| Social | 1080 × 1080, 1200 × 630 | post and link preview |
| Print | A4 794 × 1123, Letter 816 × 1056 | A4 and US Letter at 96 dpi, stated as such |
| Artwork | 1000 × 1000, 1920 × 1080 | illustration and presentation |

Print sizes are listed in **pixels at 96 dpi**, because the document model has no physical
units. The preset says so in its label; nothing claims to be a print-ready PDF.

**Naming follows the preset.** A frame created from a Web preset is named `Web page`, not
`Icon 1440×1024`; duplicates get the same ` 2`, ` 3` suffix the icon path already uses.
Icon presets keep their current names, so the icon regression suite stays meaningful.

**One creation path.** Every entry point — the toolbar's New frame menu, the dashboard's
start cards and the in-canvas start overlay — creates a frame through the same plan
(`prepareCreateIconArtboard`, which now accepts the preset's name). The menu is grouped by
the same groups the module defines, so the toolbar cannot drift from the list.

**Neutral empty state.** The dashboard opens on "New file" with a blank canvas, a web page
and a social post beside the icon start, and the copy no longer assumes icons ("Start with
a blank canvas or drop an SVG or backup"). The in-canvas overlay gains the same general
starts next to the icon one. Nothing icon-specific is removed: the icon-set view, pixel
grid and icon exports stay where they are, as options rather than as the only door in.

**Drawing anywhere already holds, and is now tested.** A new object joins the frame under
the pointer, and joins the page-level canvas root when the pointer is outside every frame
(`prepareArtboardPlacement`). That behaviour predates this pass; it is pinned here because
"general-purpose" is only true if drawing outside a 24 px box works.

### 3.8 Gradient fills — done

Fills were solid-only, and the import path proved it: `paint()` returned `null` for any
`url(#…)` paint, so a shape with a gradient fill imported with **no fill at all** — a silent
data loss, which the project's second standing rule forbids. This section was written as the
contract first, then implemented; it now describes what ships.

**The model.** `AppearanceFill` becomes a discriminated union in `src/core/types.ts`:

| Variant | Carried data | Notes |
|---|---|---|
| `solid` | `color` | unchanged; every existing document keeps working |
| `linear` | `start`, `end`, `stops` | endpoints in **object-local** space |
| `radial` | `center`, `radius`, `stops` | one circle, no focal point; focal points import as a warning |

A stop is `{ offset, color, opacity }` with `offset` clamped to 0–1 and sorted on write.
Every gradient carries at least two stops; `normalizeStops` is the only function that
enforces that, so the renderer and the exporter can trust the invariant.

**Coordinates are object-local, like nodes.** This is the one decision that makes the rest
fall out: the canvas already paints fills inside the object's transform, so a local-space
gradient needs no extra conversion to render, and exporting transforms the endpoints by the
same source→document matrix the geometry uses — including parametric instances, which get
their own matrix per occurrence. A gradient therefore moves, scales and rotates with its
shape, and mirror/radial repeats carry it correctly instead of resetting it.

Gradient placement uses the object's **anchor bounding box** (handles ignored) when a
default is needed. That box never affects geometry; it only seeds new gradients and converts
`objectBoundingBox` units on import.

**Rendering.** `drawObjectFills` builds a `CanvasGradient` per fill through `fillPaint` in
`src/canvas/renderer.ts`. Because the context is already in local space,
`createLinearGradient(start, end)` and `createRadialGradient(center, radius)` need no
transforms. Radial gradients under a non-uniform object scale become elliptical, exactly as
SVG's own `objectBoundingBox` behaviour does — that is the model, not an approximation to fix
later. A degenerate gradient (zero span or zero radius) falls back to its first stop instead
of painting nothing. The WebGL preview path is flat-colour only, so it draws a gradient's
first stop; the Canvas renderer is the default renderer and the one exports follow.

**Export.** Each gradient fill becomes one `<linearGradient>` / `<radialGradient>` in
`<defs>` with `gradientUnits="userSpaceOnUse"` and endpoints transformed into export space,
referenced as `fill="url(#id)"`. Stop opacity is written as `stop-opacity`, and the fill's
own opacity stays `fill-opacity`, so a translucent gradient survives the round trip.

**Editing.** The Fill section of the inspector (`src/ui/PropertiesPanel.tsx`) gives every
fill a **Solid / Linear / Radial** switch. Converting keeps what carries over: a solid's ink
becomes both ends of the new gradient, and a gradient's first stop becomes the ink of a new
solid. A new gradient is seeded from the object's anchor box, so it spans the shape the
moment it exists. A gradient row keeps the eye, opacity and remove controls and adds:

- an angle field for linear gradients, a radius field for radial ones (both commit on blur,
  like every other numeric field in the panel);
- one row per stop — colour well, hex field, position, stop opacity — plus add and remove;
- remove is refused, with a reason, at the two-stop minimum.

Every edit replaces the whole fill through `UPDATE_APPEARANCE`, so one edit is one history
entry. Choosing a single colour for a gradient from the **multi-selection** swatch replaces
the paint with a solid of that colour, which is what a colour well means; Undo restores the
gradient.

**Import, and the end of silent loss.** `parseSvgDocument` resolves `url(#…)` fills:

- `linearGradient` and `radialGradient` in `<defs>` are read, including stop `offset`,
  `stop-color`, `stop-opacity` and inheritance through `href`/`xlink:href`.
- `gradientUnits="objectBoundingBox"` (the SVG default) is converted with the shape's own
  box; `userSpaceOnUse` is taken as written.
- `gradientTransform` is composed onto the endpoints, which is exact for a linear gradient.
  A radial gradient keeps its centre and gets a geometric-mean radius; a transform that is
  not a similarity (skew or non-uniform scale) is reported as approximate.
- Anything that cannot be represented is **reported, not dropped**: a non-pad
  `spreadMethod`, focal points, patterns, and filter/mask/clip-path on an element each
  produce a structured warning with a code, a message and the element that caused it.
- A reference that does not resolve — a missing id, or a pattern used as paint — imports as
  **no fill plus a warning**. No colour is invented for it.
- A fill on an open path is reported; only closed paths paint a fill.

`SvgImportResult.warnings` is the contract: `{ code, message, element? }[]`. The import
receipt names the first warning and counts the rest, and the Tidy dialog lists the count
before the file is opened, so the user is told what the file contained that Keyline will not
draw.

**Refusals.** Region fills stay solid-only (they are topology-bound overrides, not object
appearance). Strokes stay solid in this pass. A gradient on an open path paints nothing,
because fills only apply to closed paths — and the import warns when it meets that case.

**Tests.** `src/core/fills.test.ts` pins stop normalization, clone isolation and the
operation-level write path; `src/canvas/renderer-fill.test.ts` pins the canvas paints;
`src/export/svg-export.gradient.test.ts` pins the `<defs>` round trip, including a scaled
occurrence and the icon-export flattening; `src/import/svg-import.gradients.test.ts` pins
objectBoundingBox conversion, `userSpaceOnUse`, `href` inheritance and every warning code;
`src/ui/PropertiesPanel.gradient.test.tsx` pins the inspector rows. The suite is **525 tests
in 79 files** as of this section.

### 3.9 Text objects — slice 1 done

There was no text entity, which was the single largest missing capability in
[`docs/PRODUCT-AUDIT.md`](PRODUCT-AUDIT.md) §4: without text, a vector editor can draw marks but
not a page. It is also the riskiest thing to bolt on, because every existing interaction —
selection, hit testing, bounds, transform, export — assumes nodes and segments. This section
was written as the contract before any code; it now describes what ships, for **slice 1**
only.

**What slice 1 is.** One-run text objects that can be inserted, edited in the inspector,
rendered on the canvas, selected, moved, rotated and scaled by the existing object transform,
exported as SVG `<text>` and imported back. Nothing about the geometry model changed.

**What slice 1 is not.** No caret, no selection inside text, no wrapping or auto-size, no
multiple runs inside one object, no custom fonts, no text on a path, no outlines. Those are
later slices, and each needs its own contract. Saying so here is what keeps the first slice
small enough to verify.

**The model.** `NetworkObject` gains one optional field:

```ts
interface TextContent {
  content: string;        // '\n' separates lines; text never wraps
  family: 'sans' | 'serif' | 'mono';
  size: number;           // px, at object scale 1
  weight: 400 | 500 | 600 | 700;
  lineHeight: number;     // multiplier of size, at least 0.5
  align: 'left' | 'center' | 'right';
}
```

Text lives **on the existing object**, with an empty network, rather than becoming a new
document-level entity. That single decision is what makes the slice small: layers, z-order,
lock/visibility, the appearance rules, `UPDATE_OBJECT`, undo, duplication, clipboard and the
document snapshot all keep working unchanged, because a text object is an object. A document
with no text is serialised exactly as before — the field is absent, not empty.

**Layout is derived, never stored.** `src/core/text.ts` turns content plus style into lines and
a box. Measurement comes from a provider: the app installs a canvas-backed one, while node and
the test suite use a deterministic fallback, so a test can assert numbers. Nothing measured is
persisted, so a file opened on another machine is laid out in that machine's fonts instead of
carrying stale pixel widths. The box is object-local — `0…width` by `0…lines × lineHeight ×
size`, origin at the object transform's origin, top-left — which is the same convention as
nodes, so nothing downstream needs a new coordinate space.

**Bounds.** `objectLocalPoints` returns the text box corners for a text object, so selection,
hit testing, alignment, arrangement, zoom-to-fit and artwork export bounds work with **no new
paths and no per-tool exceptions**. Refusal: a text object cannot join a parametric group or a
geometry component; both are geometry features and text has no geometry to substitute.

**Measurement, and its one honest caveat.** The app installs a canvas-backed metrics provider
(`src/canvas/text-metrics.ts`) at startup, so a text box matches the glyphs the canvas draws.
Node, workers and the test suite use the deterministic fallback in `src/core/text.ts`. A
document therefore carries no pixel widths, and a file opened where the fonts differ is laid
out there — which is correct for text and is why nothing measured is persisted.

**Rendering.** Lines are painted with the object's first visible fill — solid **or gradient**,
in object-local space, so gradient text costs nothing extra — under the object transform, its
opacity and its alignment. A text object's stroke is not drawn in slice 1.

**Export.** One `<text>` element with the occurrence's `transform="matrix(…)"`, `font-family`
from the family stack, `font-size`, `font-weight`, `fill`, and one `<tspan>` per line with
`x`/`y`; alignment becomes `text-anchor`. Because the tspans carry explicit positions, another
renderer does not have to agree with our metrics to place the lines.

**Import.** `<text>` and its `<tspan>` children become a text object: content from the text
nodes, `font-size`, `font-weight`, `text-anchor`, and the `transform` decomposed into
translate/rotate/uniform-scale on the object. Everything this model cannot carry is
**reported** through the same `SvgImportResult.warnings` channel as gradients (§3.8): a
`textPath`, per-run fills in one `<text>`, a non-uniform or skewed transform, `letter-spacing`,
and `textLength`. A `<text>` we cannot read at all is skipped with a warning, never silently.

**Editing, and how text gets into a document.** Slice 1 edits text in the Design panel: a
content field, family, size, weight, line height and align, each committed as one undoable
`UPDATE_OBJECT`; the section also shows the measured box. Insertion comes from the
**More → Add text** menu item and the command palette, which places a text object at the active
frame's centre and selects it. Slice 1 had no text tool and no on-canvas caret; §3.10 adds both
the `T` tool, double-click, and a caret after every insertion route. The **Edit points** control
is disabled for text with the reason "text has no points to edit" rather than opening a point
editor that has nothing to edit.

**The WebGL preview falls back to Canvas 2D for a document containing text.** The WebGL path
has no glyph atlas; drawing text as nothing would be a silent lie, so the renderer mode is
honoured everywhere else and text always paints.

**Refusals, stated rather than discovered.** No wrapping; no multi-run styling inside one
object; no text in parametric groups or geometry components; no text on a path; no stroke on
text; no custom or uploaded fonts (three families map to named stacks). Each refusal produces a
warning on import where the file asks for it, and a disabled control with a reason in the
inspector where the UI would otherwise imply support.

**Tests.** `src/core/text.test.ts` pins normalization, the deterministic metrics, layout,
bounds through `object-geometry`, selection, duplicate, undo and the snapshot round trip;
`src/canvas/renderer-text.test.ts` pins baselines, alignment offsets, transform, opacity and
gradient text; `src/export/svg-export.text.test.ts` pins the `<text>`/`<tspan>` export,
escaping and gradient fills; `src/import/svg-import.text.test.ts` pins content, lines,
alignment, transform decomposition, every text warning code and a full export→import round
trip; `src/ui/PropertiesPanel.text.test.tsx` and the toolbar menu test pin the controls. The
suite is **525 tests in 79 files** as of this section.

### 3.10 Text editing on the canvas — slice 2

Slice 1 could create and restyle text but not *type* it: every character went through the
inspector. This section is the contract for typing on the canvas, written before the code.
It adds **no persisted state** — the document still stores only content and style — so the
whole slice is UI plus one renderer option.

**The editing surface is a real text field, not a painted caret.** While a text object is
being edited, an overlay `<textarea>` sits exactly over it, in screen space, carrying the same
font, size, line height, colour and alignment as the painted text. That single decision buys
the caret, selection, word/line navigation, clipboard, undo inside the field, IME composition,
spellcheck suppression, screen-reader access and keyboard focus for free — all of them things
a hand-drawn caret would have to re-implement, badly, without a browser to test in.

**Placement is one testable function.** `textEditorPlacement` in `src/core/text-edit.ts`
composes the viewport transform with the object transform and returns the CSS the overlay
uses:

| Property | Value | Why |
|---|---|---|
| `transform` | `matrix(a, b, c, d, e, f)` of viewport ∘ object, origin `0 0` | the field lives in the object's own local space, so rotation and scale are exact |
| `width`, `height` | the measured box (`layoutText`) | the field ends where the text ends, so clicks outside it commit |
| `font` | `weight size px family stack` — the same shorthand the canvas paints with | one source, so text does not jump when editing starts |
| `line-height` | `size × lineHeight` px | matches `layoutText`'s line box |
| `text-align` | the object's alignment | caret and selection follow the text, not the box |
| `color` | the first visible fill's colour (`fillColor`) | gradient text edits against its first stop; the painted gradient returns on commit |

**The painted text is skipped while editing.** `renderVectorScene` takes
`editingTextObjectId` and does not paint that object's glyphs, so the overlay is the only text
on screen. Two renderings of the same string with slightly different metrics would otherwise
read as bold, smeared text.

**The field follows the view.** The viewport is a ref inside the canvas, so panning and zooming
do not re-render React on their own. The overlay keeps a revision counter that wheel zoom,
keyboard zoom, fit-to-selection and middle-drag panning all bump; placement is derived from it,
so the caret stays on the glyphs instead of drifting off them mid-edit.

**One editing session is one undo step.** Beginning an edit opens a transaction; every change
writes the new content through the existing `UPDATE_OBJECT` inside it; Escape, ⌘/Ctrl+Enter or
focus leaving the field commits. Undo therefore restores the text as it was before the field
was opened, not one character at a time. Because each keystroke does write to the document,
the selection frame, the inspector's measured box and export all follow live.

**Keys belong to the field while it has focus.** The canvas shortcut handler already ignores
events from editable targets, so typing `r` types `r` instead of switching to the rectangle
tool. `Enter` inserts a line (text does not wrap yet); `Tab` commits and moves focus on, so the
field is not a keyboard trap; `Escape` **commits** rather than discarding — the same choice
Figma makes — and the change stays reversible with a single Undo.

**How editing starts.** Two routes, both landing in the same state:

- the **Text** tool (`T`), where a click creates a text object at the pointer with the default
  style and opens the field immediately, so the first keystroke is the text;
- **double-clicking** an existing text object with the Select tool, which opens the field with
  the caret at the end of its content.

The More menu's **Add text** and the command palette still insert centred and now open the
field too, so every route ends with a caret in a field.

**Refusals, unchanged and restated.** Still no wrapping, no auto-size, no rich runs, no text on
a path, no text stroke, and no in-field styling. A text object still cannot join a parametric
group or a geometry component. Slice 3 is wrapping plus multiple runs, and it will need its
own contract before code.

---

## 4. What to protect while doing this

1. **The operation boundary.** UI must keep calling `manager.execute(...)`; no
   direct mutation of `document`, exactly as `README.md` and
   `docs/ARCHITECTURE.md` require. New interactions reuse existing operations
   rather than adding new state.
2. **Geometry semantics.** A resize on an object with native arcs must stay an
   arc; constraints survive a transform (see `src/constraints/`). If a proposed
   handle implementation needs to convert geometry, it is wrong.
3. **Transaction shape.** One gesture, one history entry. Pointer movement updates
   a preview; only the completed gesture commits.
4. **The existing suite.** 300+ tests describe current behaviour; a change that
   forces rewriting them is a change to the model, and should be justified as one.

---

## 5. Suggested order

| Step | Work | Unlocks |
|---|---|---|
| 1 | ~~Object resize handles and rotation~~ (done) | the editor stops contradicting its own selection UI |
| 2 | ~~Canvas group selection and one-level entry (3.2)~~ (done) | nested documents, real design files |
| 3 | ~~General-purpose framing: frame presets beyond icon sizes, neutral empty state~~ (done, 3.7) | — |
| 4 | ~~Gradients~~ (done, 3.8) · ~~Text, slice 1~~ (done, 3.9) · ~~On-canvas text editing~~ (done, 3.10); wrapping and rich runs next | — |
| 5 | AI: emit operation plans through the same validator `quick-edit.ts` uses | generated work stays editable |

Step 1 is deliberately first: it is the cheapest change with the highest perceived
quality gain, and it needs no new model concepts.

---

## 6. Shipped in this pass

Seven changes, all small and all verified by the existing gates:

- **Resize and rotate.** A quad frame on the object's own axes with eight resize
  handles and a rotate zone just outside each corner; `Shift` keeps the ratio when
  resizing and snaps to 15° when rotating; each gesture is one transaction. New
  module `src/core/object-resize.ts` with 15 unit tests.
- **Object nudge.** Arrow keys move the selection (1 px, `Shift` 10 px) as one
  undoable transaction, through the new `prepareNudgeObjects` plan in
  `src/core/object-operations.ts`. Previously arrows only worked in point editing.
- **Wheel pans the canvas.** Plain wheel or two-finger scroll pans, `Shift` +
  wheel pans horizontally, `Ctrl/⌘` + wheel or pinch zooms at the pointer, and
  `Ctrl/⌘ +` / `-` steps the zoom. See `wheelIntent` in `src/canvas/viewport.ts`.
- **Group entry and exit.** A click selects the outermost group, each double-click
  descends one level, `Escape` leaves one level. `src/core/group-context.ts` holds the
  contract, `src/core/group-context.test.ts` pins it with 11 tests.
- **Hover previews and the shared target pipeline.** `src/core/target-resolution.ts`
  answers *what will a click do here?* once, for hover, press, double-click and
  modifier clicks; the canvas draws its answer as a dashed group outline or a solid
  shape outline without touching the document. `Alt`-click selects the parent group
  (10 tests in `src/core/target-resolution.test.ts`, hover resolution measured at a
  1.4–1.6 ms median on 2000 objects).
- **General-purpose framing.** One preset list (`core/frame-presets.ts`) feeds the frame menu,
  the dashboard and the in-canvas start: Interface, Web, Device, Social, Print and Artwork sizes,
  with print sizes honestly labelled "96 dpi". Non-icon frames are named after their preset
  (`Web page`, `Social post`), duplicates get the existing numeric suffix, and the icon workflow
  keeps its `Icon N` naming. The dashboard opens on **New file** with blank-canvas and social-post
  starts beside the icon one (9 tests).
- **Truthful inspector availability.** Every disabled control in the right panel
  names its reason in its tooltip, availability comes from the visible-and-unlocked
  set the commands act on, and a frame holding a single shape can be aligned.
  `src/ui/PropertiesPanel.states.test.tsx` renders the panel in three selection
  states and fails if any disabled control is unexplained.

Everything else in sections 3 and 5 is proposed, not built.

---

## 7. How to check this audit

- `npm test` — the interaction tests named in section 3 live next to the code they
  cover (`src/tools/select-tool.test.ts`, `src/core/object-resize.test.ts`,
  `src/core/object-workflow.test.ts`, `src/canvas/viewport.test.ts`,
  `src/core/inspector-layout.test.ts`, `src/core/target-resolution.test.ts`,
  `src/ui/PropertiesPanel.states.test.tsx`).
- `npm run test:conformance` — proves the shell the handles will be drawn over is
  internally consistent.
- Read `src/canvas/VectorCanvas.tsx:651-1200` — the whole pointer-down decision
  tree, in one place, which is why these changes stay local.
