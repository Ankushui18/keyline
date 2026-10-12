# Vector Studio — Phase 5

A local-first parametric vector editor built with React, TypeScript, Canvas 2D/WebGL2, Yjs, IndexedDB, Rust, and WebAssembly. Phase 5 adds standalone SVG and solver-free React/CSS export, share-link collaboration with offline synchronization and presence, and a drop-in batched WebGL renderer while preserving every Phase 1–4 tool and document.

Release Slice 1 focuses this foundation on precision icon work: transactional frame sizing and presets, quick 24/32/48/custom icon frames, content-preserving artboard duplication, fixed-bound clean SVG export, and a polished paper-like canvas.

## Run

```bash
npm install
npm run dev
```

Production and verification commands:

```bash
npm run build
npm test
cargo test --manifest-path solver/Cargo.toml
npm run test:solver
npm run test:collaboration
npm audit
```

Rebuild the Rust/Wasm solver after editing `solver/src/lib.rs`:

```bash
npm run build:solver
```

This requires Rust, the `wasm32-unknown-unknown` target, and `wasm-pack`.

## Controls

| Tool / action | Control |
|---|---|
| Select / Pen / Shape Builder / Cut / Bend | `V` / `P` / `B` / `C` / `D` |
| Paint live region | `Shift+B` |
| Fillet / Variable Width / Offset | `F` / `W` / `O` |
| Lasso / Eraser | `L` / `E` |
| Open constraint palette | `K` or **Constraints** |
| Apply constraints contextually | Right-click after selecting geometry |
| Select multiple objects | `Shift` + click |
| Move selected nodes | Drag |
| Pan / zoom | Middle-drag or `Space` + drag / mouse wheel |
| Undo / redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |
| Resize or duplicate the active artboard | **Frame** at the top of Properties |
| Create a precision icon frame | **Add Icon Frame** in the top toolbar |
| Export | **Export** in the top toolbar |
| Share a collaboration room | **Share**, then send the copied room URL |
| Switch renderer | **2D / GPU** in the top toolbar |

Tool-specific controls:

- **Fillet:** choose a radius in the inspector and click a corner shared by two line segments. The transaction trims both lines, inserts a native tangent arc, and adds hard radius and tangency constraints.
- **Paint:** hover for striped face feedback, click to bind a solid fill to the stable region ID, or Alt-click to clear it.
- **Variable Width:** click a segment to add a width point; drag the circular center along the path or either square endpoint to resize it.
- **Offset:** set the distance in the inspector and click any segment on a path. Hold Alt/Option for the opposite side.
- **Lasso:** draw around nodes, then use Align H, Align V, Distribute, or Symmetry in the inspector.
- **Eraser:** click a segment to erase it and its direct constraints atomically. Click a selected gap endpoint to heal with a line, or Alt-click for a native arc.
- **Parametric groups:** select artwork paths and create Mirror or Radial Repeat groups from the inspector. Assign a same-artboard construction line as the live mirror axis or a construction anchor as the radial center; edit source paths and all transform parameters in Properties, or drag the selected group’s canvas control. Instances stay virtual and hit back to their authoritative source.

## Native arcs and constraints

A circular arc is persisted as typed graph geometry with:

- start and end node IDs
- center point
- radius
- start and end angles
- clockwise direction

Arc evaluation, flattening, hit testing, intersections, region outlines, shape-builder fragments, splitting, rendering, offsets, and persistence all consume this native representation. Fillets remain arcs rather than Bézier approximations.

`fixed_radius` now applies only to native arcs. Both deterministic solvers update arc radius, center, and endpoint nodes directly; the former chord-diameter proxy has been removed. Line-to-arc tangency uses the radial tangent at the shared endpoint.

The solver contract remains deterministic:

- stable ID ordering and no random values
- `f64`/`Float64` numerical state
- 100-iteration convergence limit
- default hard tolerance of `1e-6`
- explicit hard, medium, and soft projection weights
- structural conflict and residual diagnostics
- hard conflicts reject and roll back tentative mutations

## Live visual and parametric data

- Region fills remain attached to stable, boundary-derived region IDs. Region geometry is regenerated after edits while matching fills survive reshaping.
- Width profiles are persisted per segment as stable width points (`id`, normalized `t`, and width). They affect rendering only and never enter geometric solver topology.
- Mirror and Radial Repeat are non-destructive `ParametricGroup` records linked to source path IDs and optional stable construction-axis/anchor IDs. Canvas, WebGL, and SVG evaluate the same virtual transforms—including stable compound-region fills—so source or reference edits update every instance without cloning graph entities.
- Path offsets create new typed nodes, paths, and segments with fresh ULIDs while preserving the source entities.

## Transaction architecture

`OperationManager` is the only production graph-mutation boundary. It handles native segment geometry, width profiles, region fills, parametric groups, graph patches, constraints, and bulk node updates.

For solver-relevant operations it:

1. Applies the semantic mutation tentatively.
2. Runs deterministic hard-constraint pre-validation.
3. Rolls back with diagnostics on failure, or records node and native-arc adjustments in the same atomic operation batch.
4. Rebuilds derived regions and emits renderer/persistence change events.

Undo/redo therefore restores topology, constraints, fills, width data, group parameters, and solver adjustments atomically. The Rust/Wasm solver independently verifies committed documents in a Web Worker.

Key modules:

- `src/core/geometry.ts` — line, Bézier, and circular-arc kernel
- `src/core/operations.ts` — transactional semantic mutation boundary
- `src/core/regions.ts` — derived planar regions and stable IDs
- `src/constraints/solver.ts` — synchronous deterministic commit-gating solver
- `solver/src/lib.rs` — stateless Rust `f64` solver
- `src/constraints/serialization.ts` — graph/Wasm boundary including native arcs
- `src/canvas/renderer.ts` — arcs, live fills, variable widths, and virtual groups
- `src/tools/` — fillet, width, offset, lasso, eraser/heal, and earlier tools

## Phase 5 export

The Export dialog generates three dependency-free deliverables from solved typed-graph geometry:

- **SVG:** defaults to exact active-artboard bounds with a normalized `0 0 width height` viewBox and transparent padding; can optionally use tight artwork bounds or include the artboard background. Production output materializes Mirror/Repeat instances, retains compatible circular arcs, outlines variable-width strokes, emits stable region fills, rounds coordinates to three decimals by default, and omits editor metadata/source IDs.
- **React/TypeScript:** emits baked SVG geometry and typed props only for explicitly exposed, bounded export variables. No solver or Wasm runtime is included.
- **CSS Variables:** emits the same selected public controls as custom properties.

Export variables persist in version 4 snapshots and are fully transactional and undoable. Snapshot versions 1–3 remain readable.

## Collaboration

Opening a URL with `?room=...` creates a Yjs session. Every committed semantic `OperationDescriptor` is appended to the room's CRDT log, then replayed in the canonical Yjs order through `OperationManager`. Deterministic snapshot hashes provide canonical-state recovery if local replay diverges.

- `y-indexeddb` stores room state and offline edits locally.
- `y-websocket` synchronizes the operation log when connectivity returns.
- Awareness broadcasts named cursors and graph-level node/segment selections.
- The toolbar reports connecting, synced, offline, and error states.
- `npm run dev` and `npm run preview` start both the app and collaboration service. Set `VITE_COLLABORATION_URL` to an explicit WebSocket base URL when deploying them separately.

## Canvas 2D and WebGL2

The **2D/GPU** toolbar switch changes only the renderer. Both modes consume the same `VectorDocument`, viewport, selection, hit testing, and interaction operations. The WebGL path uses batched segment buffers, instanced node quads, quadtree viewport culling, zoom-dependent curve detail, triangulated fills/width outlines, and a transparent 2D interaction overlay for tool previews and remote presence. It falls back to the Canvas renderer if WebGL2 is unavailable.

## Tests

The TypeScript suite covers the Phase 1–3 foundation plus native arc geometry and persistence, direct fixed-radius solving, tangent/radius fillet invariants, live fill reshaping, width-profile persistence and topology isolation, typed offsets, live parametric group persistence, lasso bulk actions, constraint-aware erase/heal, transactional undo/redo, and serialization.

Phase 5 tests additionally cover standalone SVG fidelity, selected-variable code export and persistence, deterministic concurrent/conflicting collaboration replay, legacy snapshot replay, realtime and offline/reconnect WebSocket integration, spatial culling, and preparation of a 10,000-segment graph. Rust unit tests prove that native arc radius and endpoints are adjusted directly and that non-arc proxy geometry is rejected. The generated Wasm smoke test loads the actual artifact and verifies native-arc radius solving.

Still out of scope: new editing tools or constraint types, 3D/CAD functionality, and a mobile application.
