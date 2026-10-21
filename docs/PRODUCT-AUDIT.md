# Product audit — where Keyline is, against the full product plan

- **Date:** 21 October 2026
- **Audited commit:** `a375b5e` on `arena/9f62b6b9-keyline`
- **Scope:** the running application, its tests and its architecture, measured against the phased plan
  (P0 foundation → P5 professional).
- **Status:** this is the P0 deliverable — a gap report, not a rewrite.

> The plan this responds to describes the repository as "v0.1.0, 318 automated tests". That figure is
> out of date: the suite at this commit is **409 tests across 63 files**, plus a real Wasm smoke test,
> nine WebSocket relay checks, a design-system gate and a documentation gate. Everything below was
> re-verified at `a375b5e` rather than taken from the repository description.

The verdict up front: **the foundations are stronger than the marketing, and the interaction layer is
weaker than the foundations.** Geometry, operations, persistence and export are in better shape than a
0.1.0 normally is. What a designer would feel first — selection, path editing, general-purpose drawing
— is where the gaps are. That matches the plan's own strongest recommendation: make the next milestone
a world-class direct-selection and path-editing experience, and do not start with AI.

## 1. How this audit was produced

| Source | What it establishes |
|---|---|
| `npm run check` at this commit | build, strict TypeScript, **409 tests / 63 files**, Wasm smoke, 9 relay checks, 253 design tokens, 27 stylesheets conform, 17 docs / 30 links |
| Full read of `src/core/operations.ts` | 67 operation types; every document mutation is expressed as one |
| Hit testing, transform and history read-through | the claims in the matrix below cite `file:line`, not documentation |
| Targeted experiments | z-order hit testing (below), inspector availability, rotation about the centre |
| Absence checks | text, gradients, masks, command palette, group entry — verified by search, not by assumption |

Nothing here is a claim about visual polish judged from screenshots: this environment has no browser, so
interaction quality is measured through unit tests over the same decision functions the canvas calls.

## 2. Feature matrix

States: **Verified** (works, and a test covers the decision), **Partial** (exists with a known defect or
missing integration), **Missing**, **Unknown** (needs hands-on use to judge).

### 2.1 Interaction

| Capability | State | Evidence |
|---|---|---|
| Click selects the painted-topmost object | **Verified — fixed in this pass** | `tools/select-tool.ts` `objectsUnderPoint`; test `src/tools/select-tool.test.ts` "follows layer order after a layer is moved" |
| Select an object behind another | **Verified — added in this pass** | `nextObjectUnderPoint`, wired to `Ctrl/⌘`-click in `canvas/VectorCanvas.tsx` |
| Marquee select, additive with `Shift` | Verified | `VectorCanvas.tsx:1147`, `marqueePreview` |
| Double-click enters point editing | Verified | `VectorCanvas.tsx:1217` → `enterNetworkEditMode` |
| Anchors, handles and segments have distinct hit targets | Verified | `hitTest` node-first then `hitTestSegment`, tolerances in screen space |
| Enter/insert a point on a segment | **Verified — extended in this pass** | pen tool, plus double-click on a segment in point editing (`insertAnchorAt` in `tools/direct-path-tool.ts`) with a hover preview of where the anchor will land |
| Pull Bézier handles out of a corner | **Verified — added in this pass** | `⌥`-drag in point editing → `ADD_BEZIER_HANDLES`, one transaction per drag |
| Corner/smooth/mirrored conversion | **Verified — added in this pass** | `convertNodeTangent` derives the tangent pair alongside `SET_NODE_MODES`; 8 contract tests in `src/tools/direct-path-tool.test.ts` |
| Escape leaves the current context without losing committed edits | Verified | `exitNetworkEditMode`, one transaction per gesture |
| Double-click **enters a group**, `Escape` leaves | **Verified — added in this pass** | `core/group-context.ts` (`selectionTargetForObject`, `resolveObjectPress`, `exitGroupContext`); 10 contract tests in `src/core/group-context.test.ts` |
| Hover preview of the object under the pointer | **Verified — added in this pass** | `core/target-resolution.ts` (`resolvePointerTarget`), drawn by `drawHoverTarget` in `canvas/renderer.ts`; 10 contract tests in `src/core/target-resolution.test.ts` |
| Command palette | **Missing** | `src/ui/` has a `CommandBar` for AI text, not a searchable command palette |
| Keyboard-only operation of the canvas | **Partial** | canvas is focusable (`tabIndex` at `VectorCanvas.tsx:2363`), arrows nudge, but selection itself needs a pointer or the Layers panel |

### 2.2 Geometry

| Capability | State | Evidence |
|---|---|---|
| Native circular arcs, not flattened Béziers | Verified | typed segments, arc fields in `core/types.ts`, arc tests in `core/geometry.test.ts` |
| Eleven constraint types with a deterministic solver | Verified | `ConstraintType` in `core/types.ts:344`; solver is a real Wasm module with a smoke test |
| Constraint conflicts surfaced, not silently dropped | Verified | `ui/ConstraintDiagnostics.tsx`, unsatisfied-constraint reporting in the solver |
| Fillets, offsets, corner radius | Verified | `tools/fillet-tool.ts`, `tools/offset-tool.ts`, `core/corner-radius.ts` |
| Region merge / subtract / extract, shape builder | Verified | `MERGE_REGIONS`, `SUBTRACT_REGION`, `EXTRACT_REGION`, `tools/shape-builder.ts` |
| Transforms preserve arcs and constraints | Verified | `core/object-resize.ts` rotates about the frame centre; `prepareRotateTo`; resize tests |
| Boolean union / intersect / exclude as general path ops | **Partial** | region-level subtract/merge exists; no general boolean op over two arbitrary paths |
| Constraints discoverable through direct actions ("make these parallel") | **Partial** | `ConstraintPalette` lists types; the interaction is a list, not an inferred suggestion |
| Geometry inspector adapts to the selection | Verified | `PropertiesPanel.tsx`: arc/corner/rotation blocks appear per selection |

### 2.3 Document model

| Capability | State | Evidence |
|---|---|---|
| Arbitrary artwork, nested groups, layers, multiple pages and artboards | Verified | `core/document.ts` (`objectsForArtboard`, `_moveLayer`, pages/artboards) |
| Stable ids and versioned serialization | Verified | id factory in `core/ids.ts`; `version` field and snapshot validation in `core/document.ts` |
| Transaction boundary: no UI path mutates geometry directly | Verified | 67 operations in `core/operations.ts`; `OperationManager` is the only writer used by tools and UI |
| Text objects | **Missing** | no text entity in `core/types.ts` |
| Gradient fills | **Missing** | fills are `solid` only |
| Masks and clipping | **Missing** | `Clip content` is disabled and states why |
| Images | **Missing** | no image entity |
| Artboards as a general boundary rather than an icon frame | **Partial** | arbitrary frame sizes exist; presets are icon-flavoured (16/24/32/48) |

### 2.4 Rendering and hit testing

| Capability | State | Evidence |
|---|---|---|
| Hit testing and painting agree | **Verified — fixed in this pass** | both now derive from layer order; the old hit test walked insertion order |
| Canvas 2D renderer | Verified | `canvas/renderer.ts` |
| WebGL renderer with spatial culling | Verified | `canvas/webgl-renderer.ts`, `canvas/spatial-index.ts` (10,000-item culling test) |
| Graceful fallback when WebGL is unavailable | Verified | renderer selection in `VectorCanvas.tsx` |
| 60 FPS target on a reference document | **Unknown** | culling is tested; no in-browser frame budget measurement exists yet |

### 2.5 History and persistence

| Capability | State | Evidence |
|---|---|---|
| One undo entry per gesture | Verified | transaction tests; `core/operation-inverse-coverage.test.ts` covers every operation type |
| Undo/redo after transforms, multi-selection and AI-shaped edits | Verified | `core/operations.test.ts`, `core/object-resize.test.ts` |
| Local-first storage with document list, rename, duplicate, delete | Verified | `core/store.ts` (`loadDocumentById`, `saveDocument`, …) |
| Recovery backup and import of a failed save | Verified | `core/document-backup.ts`, dashboard restore flow |
| Autosave without blocking editing | **Partial** | saves are explicit; recovery covers failures, not continuous autosave |
| Schema migrations | **Partial** | versioned validation exists; no migration harness for older files |

### 2.6 Interchange

| Capability | State | Evidence |
|---|---|---|
| SVG import and export with round-trip tests | Verified | `import/svg-import.ts`, `export/svg-export.ts`, `svg-export.test.ts` |
| SVG **skips** clipPath, mask, gradients, patterns, filters | **Partial by design** | `SKIP_SUBTREES` in `svg-import.ts:51` — skipped silently at import, which is the plan's "explicit warning" gap |
| PNG export at custom sizes | Verified | `export/png-export.ts` |
| Code / delivery export, motion export | Verified | `export/code-export.ts`, `export/delivery-export.ts`, `export/motion-export.ts` |
| PDF export | **Missing** | — |
| Compatibility fixtures with warnings for unsupported features | **Partial** | round-trip fixtures exist; import warnings are not surfaced to the user |

### 2.7 Collaboration, accessibility, security

| Capability | State | Evidence |
|---|---|---|
| Multi-user relay with bound message limits | Verified | `server/collaboration-server.mjs`, 9 checks in `scripts/test-collaboration.mjs` |
| Presence and remote edits | Verified | `src/collaboration/session.ts` |
| Concurrent constraint edits with defined convergence | **Unknown** | the solver is per-document; no conflict semantics were audited here |
| Contrast and label conventions | Verified | design conformance: 361 ink/background pairs pass AA; disabled controls now state why |
| Modal focus trapping, Escape, focus restore | Verified | `ui/use-modal-focus.ts` plus dialogs |
| Screen-reader descriptions for canvas operations | **Partial** | controls are labelled; canvas content is not described |
| Imported SVG validated and sanitised | Verified (per `docs/AUDIT.md`) | import validation and export escaping were fixed in the earlier audit pass |

## 3. What this pass changed

Group entry and exit (see §2.1 and `docs/EDITING-AUDIT.md` §3.2), preceded by two P1 interaction
defects found by the audit rather than reported:

1. **Selection disagreed with the picture.** `hitTestObject` walked `document.objects` in insertion
   order, while the renderer paints in layer order. Reorder a layer in the Layers panel and clicking a
   shape selected a different one. Both now resolve through `objectsInPaintOrder`; the construction-line
   special case (an *infinite* line is clickable outside its bounds) is preserved deliberately, and an
   object above the line still wins.
2. **Nothing could be selected behind anything.** `Ctrl/⌘`-click now walks down the stack under the
   pointer and wraps, so the shape hidden behind another is one gesture away instead of a trip to the
   Layers panel.

Both are covered by tests in `src/tools/select-tool.test.ts` (9 tests in that file, three of them new).

## 4. Gap report, in dependency order

Ordered by dependency and by what a designer would feel first — not by how interesting the work is.

| # | Gap | Why it blocks | Size |
|---|---|---|---|
| 1 | ~~Group entry on the canvas~~ (done in this pass) | — | — |
| 2 | ~~Hover affordance (object/segment preview before clicking)~~ (done in this pass) | — | — |
| 3 | Text objects (entity, editing, SVG round trip) | Excludes branding and typography entirely — the largest single missing capability | L |
| 4 | Gradient fills | Same: branding work is not possible with solids alone | M |
| 5 | Command palette over existing operations | Makes 67 operations discoverable without a wider toolbar | M |
| 6 | General boolean ops and compound paths | "Complete vector editor" claims need them; region ops only partly cover | L |
| 7 | Import warnings for skipped SVG features (mask, clip, gradient, filter) | Silent data loss is a trust problem, and trust is the product's differentiator | S |
| 8 | Continuous autosave | Local-first promise is only half kept today | M |
| 9 | Reference-document performance measurement | The 60 FPS and large-document claims are currently unverified | M |
| 10 | AI operation plans through the existing validator (`core/quick-edit.ts` seed) | Everything above must be stable before generated geometry can be trusted | L |

## 5. What to protect while closing those gaps

These are the non-negotiables from the plan, and they already hold at this commit:

1. **One document, one transaction boundary.** 67 operation types, inverse coverage tested per type.
   No new tool may write to the document directly.
2. **Preview ≠ commit.** Pointer movement updates a preview; only the completed gesture commits.
3. **Semantic geometry.** Arcs stay arcs; translation, rotation and constraints survive edits.
4. **Versioned serialization.** Every schema change needs a round-trip test.
5. **Truthful UI.** A disabled control states why; a control that is enabled changes something
   (enforced by `src/ui/PropertiesPanel.states.test.tsx`).

## 6. Recommendation

Adopt the plan's P1 milestone as stated: **direct selection and path editing**, delivered as three
increments, each shippable on its own.

1. *Selection truth* — done: paint order, `Ctrl/⌘`-click cycling, and hover previews that resolve
   through the same pipeline as the click (measured at a 1.4–1.6 ms median per pointer move on a
   2000-object document, so it fits a 16 ms frame).
2. *Group navigation* — done: a click selects the outermost group, each double-click descends one
   level, `Escape` steps out. Known limit: deleting a group selection leaves the empty group layer.
   Also done: hover outlines for groups and shapes, and `Alt`-click to select the parent group
   (`Alt`-drag still duplicates; the two are separated by movement).
3. *Path editing polish* — done in this pass for insertion and corner conversion: the insert point
   is previewed before commit, and `Sharp` / `Smooth` / `Mirrored` derive a tangent instead of only
   recording a mode. Still open: per-anchor corner/smooth state drawn on the canvas, and
   arc-specific handles.

AI work should start only after step 3, and only as operation plans validated by the same code
that validates manual edits. Text and gradients are the next product-level expansion after the
interaction layer, because they gate every non-icon audience in the plan's table.
