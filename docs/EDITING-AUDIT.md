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
| Multi-artboard documents | yes; frames are created from a menu of 24/32/48 presets plus custom size | `ui/Toolbar.tsx:165-180` | works, icon-flavoured |
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

### 3.6 Typography and gradients are absent, not weak

There is no text entity and no gradient fill type. These are feature projects, not
interaction fixes, and they should be sequenced after the interaction layer —
otherwise there is a sophisticated engine with nothing comfortable to draw with.

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
| 3 | General-purpose framing: frame presets beyond icon sizes, neutral empty state | illustration and layout work in the same editor |
| 4 | Text and gradients (3.6) | typography and illustration, the two missing media |
| 5 | AI: emit operation plans through the same validator `quick-edit.ts` uses | generated work stays editable |

Step 1 is deliberately first: it is the cheapest change with the highest perceived
quality gain, and it needs no new model concepts.

---

## 6. Shipped in this pass

Six changes, all small and all verified by the existing gates:

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
