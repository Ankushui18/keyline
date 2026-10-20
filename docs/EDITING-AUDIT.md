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
| Drag to move | yes, `Alt`-drag duplicates | `VectorCanvas.tsx:1704` | works |
| Arrow-key nudge, objects | yes, 1 px / `Shift` 10 px, one undo step | `App.tsx:1843`, `core/object-operations.ts:253` | **added in this pass** |
| Arrow-key nudge, points | yes | `App.tsx:1871` | works |
| Drag a corner to **resize** an object | **no** — objects draw a plain box (`renderer.ts:1102`) and dragging a corner moves the shape instead | `VectorCanvas.tsx:1103` handles artboards only | **missing** |
| Rotate handle | **no** — rotation is a numeric field | `ui/PropertiesPanel.tsx:1508` | **missing** |
| Double-click a shape | enters point editing (also `Enter`) | `VectorCanvas.tsx:621` | works |
| Double-click **enters a group** | **no** — clicks resolve to the leaf object; groups are selectable only in the Layers panel | `ui/LayersPanel.tsx:452`, isolation at `core/document.ts:317` | **missing** |
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

### 3.1 Selection feedback without resize handles

A selected object draws an axis-aligned rectangle (`renderer.ts:1102`) with no
handles. The rectangle reads as "you can drag these corners", but a press on a
corner starts a *move* gesture, because the hit test resolves to the object. This
is the single most misleading interaction in the editor.

**Smallest change:** add a `resize-object` gesture next to the existing
`resize-artboard` one. Both share a handle model already (`ArtboardResizeHandle`,
`VectorCanvas.tsx:108`), and the commit path is `UPDATE_OBJECT` with a new
`scaleX`/`scaleY`, which the operation vocabulary already supports. Draw 8
handles in `drawObjectSelection`, hit-test them before the object bounds, and
keep `Shift` for proportional scaling.

**Cost:** one gesture kind, one renderer change, one hit-test branch.
**Tests:** handle hit priority; proportional scaling; single undo entry per drag.

### 3.2 Groups cannot be entered on the canvas

`hitTestObject` returns the leaf object, so a click inside a group always grabs
the leaf. The Layers panel can select and group layers, but the canvas cannot
address the group at all. The nearest existing primitive, isolation, hides every
other object, which is a heavier mode than "step into this group".

**Smallest change:** give `SelectionState` a `layerIds` target and resolve hits to
the *highest* ancestor group that is not already entered, then let each subsequent
double-click descend one level and the next one enter point editing.

**Cost:** this is the largest of the four — selection shape, hit-test resolution,
renderer outline, move/resize on a group, layer-panel sync.
**Do it after 3.1**, because group bounds reuse the object-handle work.

### 3.3 Rotation is not a direct manipulation

Rotation exists in the transform (`types.ts:257`) and as a number field
(`PropertiesPanel.tsx:1508`), but there is no handle and no gesture.

**Smallest change:** a rotation zone just outside the corner handles added in 3.1,
snapping to 15° with `Shift`. Commit is `UPDATE_OBJECT` with `rotation`.

### 3.4 Typography and gradients are absent, not weak

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
| 1 | Object resize handles, then rotate (3.1, 3.3) | the editor stops contradicting its own selection UI |
| 2 | Canvas group selection and one-level entry (3.2) | nested documents, real design files |
| 3 | General-purpose framing: frame presets beyond icon sizes, neutral empty state | illustration and layout work in the same editor |
| 4 | Text and gradients (3.4) | typography and illustration, the two missing media |
| 5 | AI: emit operation plans through the same validator `quick-edit.ts` uses | generated work stays editable |

Step 1 is deliberately first: it is the cheapest change with the highest perceived
quality gain, and it needs no new model concepts.

---

## 6. Shipped in this pass

Two changes, both small and both verified by the existing gates:

- **Object nudge.** Arrow keys move the selection (1 px, `Shift` 10 px) as one
  undoable transaction, through the new `prepareNudgeObjects` plan in
  `src/core/object-operations.ts`. Previously arrows only worked in point editing.
- **Wheel pans the canvas.** Plain wheel or two-finger scroll pans, `Shift` +
  wheel pans horizontally, `Ctrl/⌘` + wheel or pinch zooms at the pointer, and
  `Ctrl/⌘ +` / `-` steps the zoom. See `wheelIntent` in `src/canvas/viewport.ts`.

Everything else in sections 3 and 5 is proposed, not built.

---

## 7. How to check this audit

- `npm test` — the interaction tests named in section 3 live next to the code they
  cover (`src/tools/select-tool.test.ts`, `src/core/object-workflow.test.ts`,
  `src/canvas/viewport.test.ts`).
- `npm run test:conformance` — proves the shell the handles will be drawn over is
  internally consistent.
- Read `src/canvas/VectorCanvas.tsx:651-1200` — the whole pointer-down decision
  tree, in one place, which is why these changes stay local.
