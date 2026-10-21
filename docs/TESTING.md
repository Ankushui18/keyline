# Testing

What is verified, how to run it, and what the suites do **not** prove.

Current suite: **498 tests across 76 test files**, plus a real Wasm smoke test, nine WebSocket
integration checks, Rust unit tests, and optional browser suites.

- [Run everything](#run-everything)
- [Suite inventory](#suite-inventory)
- [Wasm solver smoke test](#wasm-solver-smoke-test)
- [WebSocket integration test](#websocket-integration-test)
- [Rust tests](#rust-tests)
- [Browser suites](#browser-suites)
- [Documentation checks](#documentation-checks)
- [Adding tests](#adding-tests)
- [Limits of this evidence](#limits-of-this-evidence)

---

## Run everything

```bash
npm ci
npm run check
```

`check` runs, in order: the design-system checks, the production build (with strict TypeScript), the
Vitest suite, the Wasm smoke test, the WebSocket relay suite, and the documentation check.

Two suites render React into jsdom (`@testing-library/react`), which is why `jsdom`,
`@testing-library/react` and `@testing-library/dom` are dev dependencies. Everything else runs in
plain Node.

Individual commands:

```bash
npm test
npm run typecheck
npm run test:solver
npm run test:collaboration
npm run check:docs
```

CI runs the same commands on Node 22, plus `cargo test` on Rust stable.

---

## Suite inventory

Tests live beside their source as `*.test.ts`. Grouped by what they protect:

### Geometry and document model

| File | Protects |
|---|---|
| `core/geometry-components.test.ts` | Source/variant topology maps, propagation previews, overrides, detach/keep-local. |
| `core/construction-geometry.test.ts` | Construction-line geometry and extents. |
| `core/construction-operations.test.ts` | Construction anchors, role changes, removal safety. |
| `core/segment-semantics.test.ts` | Geometry vs construction segment rules. |
| `core/region-geometry.test.ts` | Loop orientation, winding/even-odd hit testing. |
| `core/regions.test.ts` | Region detection, stable IDs, fill persistence across reshaping. |
| `core/region-tolerance.test.ts` | Near-coincident topology tolerance. |
| `core/region-performance.test.ts` | Region derivation stays within budget. |
| `core/object-workflow.test.ts`, `core/object-operations` coverage | Objects, transforms, delete/duplicate/flip plans. |
| `core/artboard-operations.test.ts` | Icon frames, duplication with content, conservative starter cleanup. |
| `core/document.test.ts`, `core/document-foundation.test.ts` | Construction, validation and snapshot round-trips. |
| `core/document-backup.test.ts` | `.keyline.json` restore validation and fresh-ID loading. |
| `core/parametric-references.test.ts` | Mirror/repeat references to construction geometry. |
| `core/appearance-rules.test.ts` | Shared style rules and propagation. |

### Transactions and operations

| File | Protects |
|---|---|
| `core/operations.test.ts` | Apply/undo/redo semantics. |
| `core/operation-inverse-coverage.test.ts` | Every operation has a correct inverse. |
| `core/phase2-operations.test.ts`, `core/phase4.test.ts` | Batch behaviour, fills, width profiles, groups. |
| `core/keyline-features.test.ts` | End-to-end feature contracts across recent slices. |
| `core/store.test.ts` | IndexedDB save/rename/duplicate/delete, revision-aware autosave, lifecycle flush. |
| `core/preferences.test.ts` | Denied/quota-exhausted storage falls back safely. |
| `core/browser-clipboard.test.ts`, `core/clipboard.test.ts` | Permission-safe clipboard and payload round-trips. |

### Constraints

| File | Protects |
|---|---|
| `constraints/solver.test.ts` | Determinism, hard/medium/soft weights, conflicts, native-arc radius. |
| `constraints/construction-constraints.test.ts` | Constraints against construction references. |
| `constraints/construction-wasm-parity.test.ts` | TypeScript and Wasm agree on construction cases. |

### Canvas and rendering

| File | Protects |
|---|---|
| `canvas/region-fill-parity.test.ts` | Canvas/WebGL fill-rule parity. |
| `canvas/stroke-alignment-parity.test.ts` | Inside/centre/outside stroke alignment parity. |
| `canvas/object-selection.test.ts` | Hit testing and selection semantics. |
| `canvas/viewport.test.ts`, `canvas/zoom-stroke.test.ts` | Pan/zoom math and zoom-independent strokes. |
| `canvas/spatial-index.test.ts` | Quadtree inserts, queries, culling. |
| `canvas/webgl-construction.test.ts` | Infinite construction-line buffers remain finite. |
| `canvas/webgl-performance.test.ts` | Batched preparation of large graphs. |

### Tools

`pen-tool`, `pencil-tool`, `brush-tool`, `primitive-tool`, `select-tool`, `lasso-tool`,
`eraser-tool`, `fillet` (covered by constraint/feature suites), `bend-tool`, `width-tool`,
`construction-tool`, `snapping`, `path-commands` — each verifies its prepared plan without
touching the document.

### Export and import

| File | Protects |
|---|---|
| `export/svg-export.test.ts` | Bounds modes, arc retention, width outlining, fill rules, enum validation, escaping. |
| `export/code-export.test.ts` | React/CSS generation, hostile values, name collisions, bounded props. |
| `export/delivery-export.test.ts` | Naming patterns, collisions, presets, ZIP planning. |
| `import/svg-import.test.ts` | Path parsing, transforms, style extraction. |
| `import/svg-import.gradients.test.ts` | `url(#…)` fills: objectBoundingBox conversion, `userSpaceOnUse`, `href` inheritance, and every warning code (pattern, missing id, spread, focal, skew, filter, open path). |

### Collaboration and UI helpers

| File | Protects |
|---|---|
| `collaboration/session.test.ts` | Same-origin URL policy, local file identity, transport-stable hashes, replay, legacy snapshots. |
| `core/inspector-layout.test.ts` | Alignment/distribution math. |
| `core/icon-start-regression.test.ts` | First-icon onboarding and conservative starter repair. |
| `core/drawing-style.test.ts` | Style defaults and normalization. |
| `core/numeric-expression.test.ts` | Numeric field expressions. |
| `ui/contrast-color.test.ts` | Accessible avatar/text colour selection. |
| `ui/PropertiesPanel.states.test.tsx` | Every disabled inspector control carries a reason, rendered in three selection states. |
| `ui/PropertiesPanel.gradient.test.tsx` | The fill type switch, stops and angle/radius rows, and the two-stop minimum, rendered from a static inspector. |
| `core/fills.test.ts` | Gradient model: stop normalization, clone isolation, the operation-level write path, object-local geometry and preview CSS. |
| `core/text.test.ts` | Text model and layout: normalization, deterministic metrics, box maths, bounds through `object-geometry`, selection, duplicate, undo, snapshot. |
| `canvas/renderer-text.test.ts` | Text paints baselines, alignment offsets, transform, opacity and gradients; nothing without a visible fill. |
| `export/svg-export.text.test.ts` | `<text>`/`<tspan>` export, anchors, escaping, gradient fills, icon-ink flattening. |
| `import/svg-import.text.test.ts` | Text import: content, lines, anchors, transform decomposition, every text warning code, export→import round trip. |
| `ui/PropertiesPanel.text.test.tsx` | The text section's controls, the alignment state, and the disabled Edit points reason. |
| `canvas/renderer-fill.test.ts` | The canvas paints a linear and a radial gradient in local space and refuses a degenerate one. |
| `export/svg-export.gradient.test.ts` | Gradient `<defs>` round trip, scaled occurrences, and icon-export flattening. |
| `ui/panel-controls.test.tsx` | Every **enabled** inspector and tool control reaches the document or its callback, across nine states (jsdom). |
| `core/frame-presets.test.ts` | One frame-preset list: groups, preset naming, duplicate numbering, and drawing outside every frame. |
| `ui/Toolbar.frame-menu.test.tsx` | Every preset reaches the frame menu, in its group, creating the frame it promises (jsdom). |
| `ui/Dashboard.empty-state.test.tsx` | The dashboard opens on a general-purpose file and offers the icon start as an option (jsdom). |
| `tools/direct-path-tool.test.ts` | Anchor insertion that preserves the curve, the anchor hit test, corner/smooth/mirrored conversion, and the three handle-mirroring modes. |
| `core/target-resolution.test.ts` | Hover and press resolve through one pipeline: paint order, entered groups, hidden/locked ancestors, the `Alt`-click parent gesture, and a measured latency budget. |

---

## Wasm solver smoke test

`npm run test:solver` runs `scripts/test-solver.mjs`, which **loads the actual compiled
artifact** in `solver/pkg/` and exercises:

- native-arc radius and endpoint adjustment,
- rejection of invalid geometry,
- malformed input handling,
- determinism across repeated runs.

This is a real boundary test, not a mock. It does not prove that `solver/pkg/` was built from the
current `solver/src/lib.rs`; source-to-artifact reproducibility is a separate concern.

---

## WebSocket integration test

`npm run test:collaboration` starts a real relay and runs nine checks:

1. The health endpoint responds without exposing room data.
2. Two real WebSocket clients synchronise edits.
3. Offline edits converge after reconnect.
4. Different rooms cannot read each other.
5. Invalid room paths and query parameters are rejected.
6. Cross-origin upgrades are rejected by default.
7. An explicit deployment origin allowlist is enforced.
8. Oversized messages close with WebSocket code `1009`.
9. Idle room state is released after its retention period.

---

## Rust tests

```bash
cargo test --manifest-path solver/Cargo.toml
```

These prove direct native-arc solving and that non-arc proxy geometry is rejected. CI runs them;
the local sandbox used for the audit did not have a Rust toolchain, so the committed Wasm
artifact was exercised instead. See [AUDIT.md](AUDIT.md).

---

## Browser suites

The browser suites drive Chromium through the Arena `playwright-cli` session. They need the app
running and are **not** part of CI.

```bash
npm run dev    # terminal 1
playwright-cli -s=arena open http://127.0.0.1:5173 --browser=chromium
npm run test:browser
npm run test:design
npm run test:review
playwright-cli -s=arena close
```

They cover, in isolated browser contexts:

- reload persistence and undo/redo,
- SVG download and clipboard denial,
- modal focus containment and opener restoration,
- blocked local storage,
- live and offline collaboration,
- dashboard file management,
- icon-set view and consistency fixes,
- sidebar layout, divider resizing and compact Design controls,
- first-icon onboarding,
- automated WCAG A/AA checks (axe) in multiple UI states.

Results, screenshots and logs are written to `audit/`, which is ignored by Git. The last recorded
run is summarised in [AUDIT.md](AUDIT.md).

---

## Documentation checks

`npm run check:docs` (`scripts/check-docs.mjs`) verifies:

- every relative Markdown link and image resolves,
- required repository files exist,
- no generated artifact (`.tsbuildinfo`, `vite.log`) is tracked by Git,
- with `--results <vitest.json>`, the README badge and the counts in this document match the
  suite that actually ran.

CI generates the report and runs the check:

```bash
npx vitest run --reporter=json --outputFile=audit/vitest.json
node scripts/check-docs.mjs --results audit/vitest.json
```

---

## Adding tests

1. Put the test next to the source as `<module>.test.ts`.
2. Prefer behaviour over implementation: assert document state, emitted operations, or bytes,
   not private method calls.
3. For every new operation, add an inverse round-trip test (see
   `core/operation-inverse-coverage.test.ts`).
4. For geometry, include a degenerate case: zero-length, collinear, coincident, reversed or
   near-tolerance input.
5. For export, include a hostile value (quotes, `</script>`, `$&`, invalid enum) and prove it is
   escaped or rejected.
6. For persistence, use `fake-indexeddb` and assert both the stored snapshot and the UI-facing
   summary.
7. Update the counts in `README.md` and this file, then run `npm run check:docs`.

Do not weaken a test to make a change pass. If behaviour is intentionally changing, update the
assertion and explain why in the commit message.

---

## Limits of this evidence

- **No formal verification.** Constraint solving is tested numerically; it is not proved correct
  for all inputs.
- **No fuzzing campaign** is committed. Hostile input cases are written by hand.
- **No screen-reader or manual WCAG audit.** Automated axe checks catch a subset of issues.
- **Performance tests are budgets, not benchmarks.** They run in Node with synthetic data.
- **Browser suites are manual-only** and were run in Chromium, not Firefox or Safari.
- **Rust artifact reproducibility is not verified** in this environment.
