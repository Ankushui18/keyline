# Changelog

Notable changes to Keyline. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses semantic versioning once it publishes releases.

## [Unreleased]

### Added

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
