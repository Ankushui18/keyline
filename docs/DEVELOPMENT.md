# Development

Setup, scripts, environment variables, the Rust/Wasm rebuild, and troubleshooting.

- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Scripts](#scripts)
- [Environment variables](#environment-variables)
- [Rebuilding the Rust/Wasm solver](#rebuilding-the-rustwasm-solver)
- [Production build](#production-build)
- [Conventions](#conventions)
- [Troubleshooting](#troubleshooting)
- [Release checklist](#release-checklist)

---

## Requirements

| Tool | Version | Needed for |
|---|---|---|
| Node.js | **20.19+ or 22.12+** (22 LTS recommended) | App, tests, scripts |
| npm | 10+ | Dependency installation |
| Rust + `wasm32-unknown-unknown` + `wasm-pack` | stable | Rebuilding `solver/pkg/` only |
| Playwright CLI + Chromium | preinstalled session | Browser suites only |

The app **runs without Rust**: the compiled Wasm package is committed to `solver/pkg/`.

---

## Install and run

```bash
git clone https://github.com/Ankushui18/keyline.git
cd keyline
npm ci
npm run dev
```

`npm run dev` starts two processes and stops both together:

1. the collaboration relay on `127.0.0.1:1234` (loopback only), and
2. Vite on `0.0.0.0:5173`.

Vite proxies `/collaboration` (including WebSocket upgrades) to the relay. If the relay does not
become ready within 15 seconds, or either child exits, the runner terminates the other child so
no orphan process is left behind. Vite runs with `--strictPort`, so a busy port fails loudly.

```bash
npm run preview     # production build preview + relay
npm run collab      # relay only (no app)
```

---

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | App + collaboration relay in development. |
| `npm run build` | `tsc -b` then `vite build` into `dist/`. |
| `npm run preview` | Serves the production build + relay. |
| `npm run typecheck` | TypeScript project build, no emit. |
| `npm test` | Vitest unit/integration suite. |
| `npm run test:solver` | Loads the real Wasm artifact and checks native-arc solving. |
| `npm run test:collaboration` | Nine WebSocket integration checks against a real relay. |
| `npm run check:docs` | Validates relative doc links and required files. |
| `npm run check:design` | Design-system gate: tokens, CSS↔TS parity, literal-colour ratchet, contrast. |
| `npm run migrate:colors` | Codemod that replaces literal hex with design tokens (dry run with `--report`). |
| `npm run check` | Design gate + build + tests + solver + relay + docs. The full local gate. |
| `npm run build:solver` | Rebuilds `solver/pkg/` with `wasm-pack`. |
| `npm run test:browser` | End-to-end + accessibility suite (needs a running app and Playwright CLI). |
| `npm run test:design` | Sidebar layout/resizing/accessibility suite. |
| `npm run test:review` | Palette, icon rendering and onboarding regressions. |

Browser output is written to `audit/` (ignored by Git). See [TESTING.md](TESTING.md).

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `COLLABORATION_PORT` | `1234` | Relay port; also used by the runner and the Vite proxy. |
| `COLLABORATION_HOST` | `127.0.0.1` | Relay bind address. Do **not** expose it publicly without hardening. |
| `COLLABORATION_ALLOWED_ORIGINS` | *(empty)* | Comma-separated exact browser origins for a separately exposed relay. When empty, same-host origins are accepted. |
| `VITE_COLLABORATION_URL` | same-origin `/collaboration` | Explicit WebSocket base URL when the relay is deployed separately (may include `/collaboration`). |
| `VITE_ALLOWED_HOSTS` | *(empty)* | Extra comma-separated hostnames for Vite's host allowlist. `localhost`, IP addresses and Arena `.e2b.app` previews are accepted by default. |

Example:

```bash
COLLABORATION_PORT=1300 npm run dev
VITE_ALLOWED_HOSTS=keyline.internal npm run dev
```

Environment variables are read at build time by Vite where prefixed `VITE_`; restart the server
after changing them.

---

## Rebuilding the Rust/Wasm solver

Only needed after editing `solver/src/lib.rs`.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack        # once
npm run build:solver           # wasm-pack build solver --target web --release --out-dir pkg
npm run test:solver            # loads the artifact and checks native-arc solving
cargo test --manifest-path solver/Cargo.toml
```

Notes:

- `solver/pkg/` **is committed**. Do not add it to `.gitignore`; contributors without Rust rely
  on it. `solver/target/` is ignored.
- The Wasm module is loaded by `src/constraints/solver-worker.ts`; the boundary is JSON
  (`solve_json`) via `src/constraints/serialization.ts`.
- TypeScript and Rust must agree on the numeric contract: 100 iterations, `1e-6` tolerance, and
  hard/medium/soft weights. Change both together and run the parity tests.
- Determinism requires sorted inputs; do not introduce map iteration order or randomness.

---

## Production build

```bash
npm run build
npm run preview
```

The build splits output into independently cacheable chunks: React vendor, application,
JSZip (loaded only for ZIP delivery), Canvas renderer, WebGL renderer, and per-dialog chunks.
Current sizes are reported by Vite; treat regressions as a review item, not a hard gate.

`dist/` is a static site. Serve it over HTTPS. If collaboration is required, either run the relay
behind the same origin under `/collaboration` or set `VITE_COLLABORATION_URL` at build time and
apply the deployment hardening in [COLLABORATION.md](COLLABORATION.md#deployment-boundary).

---

## Conventions

- **Never mutate geometry outside `OperationManager`.** Tools and panels return operations; the
  manager applies them. See [ARCHITECTURE.md](ARCHITECTURE.md#the-one-rule).
- **Every operation needs an inverse** and a test round-tripping it.
- **Tests live next to the source** as `*.test.ts`. Pure domain tests run in Node; IndexedDB
  tests use `fake-indexeddb`.
- **TypeScript is strict** with `noUnusedLocals` and `noUnusedParameters`. Do not silence errors
  with `any` or `@ts-ignore`; fix the type or narrow it.
- **New numeric behaviour needs a property or boundary test**, not only a happy path.
- **Export is a trust boundary.** Validate/escape values at emission; never interpolate
  untrusted strings into SVG, JSX, CSS or file names.
- **CSS is layered by slice.** Add rules to the most recent relevant file (`keyline-reference-final.css`,
  `design-sidebar.css`, `dashboard.css`, …) rather than creating a new layer; `main.tsx` import
  order is significant.
- **Accessibility is a requirement.** New dialogs use the shared focus utilities, new icon-only
  controls need labels, and text contrast must pass the automated checks.
- **Docs are part of the change.** Update the user guide for behaviour changes and run
  `npm run check:docs`.

---

## Troubleshooting

### `npm ci` fails after changing dependencies

`npm ci` requires `package.json` and `package-lock.json` to agree. Update the lockfile
deliberately with `npm install`, commit both files, and re-run `npm ci`.

### `EBADENGINE` or Vite refuses to start

Check `node -v`. Vite 7 needs Node **20.19+ or 22.12+**. Older Node 20 releases fail at startup
even though they satisfy `>=20`.

### Port 5173 or 1234 is already in use

The dev runner uses `--strictPort`, so it fails instead of silently moving. Stop the other
process or set `COLLABORATION_PORT`. The app port can be changed by passing Vite arguments:

```bash
npm run dev -- --port 5180
```

### The relay never becomes ready

- Run `npm run collab` alone to see its logs.
- Confirm nothing else is bound to the port: `lsof -i :1234` (macOS/Linux).
- A wrong `COLLABORATION_HOST` (for example an address the host does not own) prevents binding.

### Sharing connects but immediately errors

- Browser-facing code must use the same-origin `/collaboration` proxy. Do not point the browser
  at `localhost` or another preview port; those are not the relay from the browser's point of
  view.
- Behind a different hostname, add it to `VITE_ALLOWED_HOSTS`.
- Behind a separately exposed relay, set `COLLABORATION_ALLOWED_ORIGINS` to the exact origin.

### Blank page after pulling changes

1. Stop the dev server.
2. `rm -rf node_modules/.vite dist`
3. `npm ci && npm run dev`

A stale dependency-optimizer cache is the usual cause. Check the browser console for a module
error before assuming a build failure.

### "Wasm solver failed to load"

- Confirm `solver/pkg/vector_solver_bg.wasm` exists.
- If you just rebuilt, verify all `solver/pkg/*` files changed together.
- The UI continues with the TypeScript solver preflight; the worker status indicator shows the
  failure rather than blocking editing.

### Browser suites cannot find Playwright

They require the Arena session's preinstalled `playwright-cli` and an open session:

```bash
playwright-cli -s=arena open http://127.0.0.1:5173 --browser=chromium
```

The runner reports this clearly and exits non-zero. These suites are intentionally excluded
from CI.

### "Couldn't save. Storage may be full."

IndexedDB is blocked, in private-mode restrictions, or at quota.

- The app keeps working in memory.
- Use **Download a copy**, then import the `.keyline.json` from the dashboard on a device where
  storage works. Restoring creates a new file and never overwrites the original.
- Clear old files from the dashboard to free quota.

### Rust build fails on `wasm-bindgen` versions

Use a current stable Rust and a current `wasm-pack`. The crate pins only major versions; the
lockfile records the exact graph. Do not hand-edit `solver/Cargo.lock`.

---

## Release checklist

1. `npm ci`
2. `npm run check`
3. `cargo test --manifest-path solver/Cargo.toml` (if Rust is available)
4. Manual smoke test: draw, constrain, reload, export SVG and React, open the exported files.
5. Browser suites where a Playwright session is available.
6. Update `CHANGELOG.md`, the README test badge, and [TESTING.md](TESTING.md) counts.
7. `npm run check:docs`
