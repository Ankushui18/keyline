# Contributing

Thanks for taking the time to improve Keyline. This project values **correct geometry, honest
documentation and small reviewable changes** over feature volume.

- [Before you start](#before-you-start)
- [Set up](#set-up)
- [Make a change](#make-a-change)
- [What CI checks](#what-ci-checks)
- [Code conventions](#code-conventions)
- [Tests](#tests)
- [Documentation](#documentation)
- [Commit messages](#commit-messages)
- [Reporting bugs](#reporting-bugs)
- [Feature scope](#feature-scope)

---

## Before you start

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-one-rule). Most design decisions follow
  from the single mutation boundary.
- Search existing issues and pull requests.
- For anything larger than a bug fix or a small UI improvement, open an issue first and describe
  the approach. It is cheaper than reworking a large PR.
- Security issues go through [SECURITY.md](SECURITY.md), not the public issue tracker.

---

## Set up

```bash
git clone https://github.com/Ankushui18/keyline.git
cd keyline
npm ci
npm run dev
```

Node **20.19+ or 22.12+** is required. Rust is optional and only needed to rebuild the Wasm
solver. Full details: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

## Make a change

1. Branch from `main`.
2. Keep the change focused. Separate refactors from behaviour changes.
3. Add or update tests (see below).
4. Update the docs the change makes stale.
5. Run `npm run check`.
6. Open a pull request describing **what changed, why, and how it was verified**.

Do not commit generated artifacts: `node_modules/`, `dist/`, `audit/`, `*.tsbuildinfo`, logs or
`solver/target/`. `solver/pkg/` is the deliberate exception (see the Wasm section).

---

## What CI checks

`.github/workflows/ci.yml` runs on every push and pull request:

- `npm ci` against the committed lockfile,
- strict TypeScript and a production build,
- the full Vitest suite,
- the real Wasm smoke test,
- the WebSocket relay integration suite,
- Rust unit tests on stable,
- the documentation checker (links, required files, tracked artifacts).

Browser suites are **not** in CI; run them locally if you have the Playwright CLI session
available. A PR that changes UI behaviour should say whether those suites were run.

---

## Code conventions

### The mutation rule

Never mutate document geometry outside `OperationManager`. Tools and panels produce
`OperationDescriptor`s or prepared plans; the manager applies them. Every new operation needs:

- validation,
- an inverse,
- region refresh if it can affect topology,
- a test that applies and reverses it.

### Types

TypeScript is strict with `noUnusedLocals` and `noUnusedParameters`. Avoid `any`, `@ts-ignore`
and unchecked casts. Validate at boundaries (persistence, clipboard, collaboration, import) and
keep the core typed.

### Determinism

Solver-adjacent code must sort inputs, avoid randomness, and use bounded iteration. Map iteration
order must not influence numeric results. This is required for collaboration replay and tests.

### Rendering

Canvas 2D and WebGL2 must stay equivalent. If you change one path, check the parity tests and
update the other.

### Styling

Add rules to the most recent relevant stylesheet in `src/styles/`; import order in `main.tsx` is
significant. Avoid inline styles except for computed values (cursors, transforms).

### Accessibility

- New dialogs use the shared focus utilities (`use-modal-focus.ts`, `useDialogEscape`).
- Icon-only buttons need an `aria-label`.
- Do not remove focus outlines without an equivalent visible indicator.
- Check contrast for new text/background pairs; `ui/contrast-color.test.ts` describes the
  luminance rule used for avatars.

### Trust boundaries

Export, import, clipboard and collaboration data are untrusted. Escape values at emission, allow
list enums, bound numbers and sanitize file names. Do not assume upstream validation.

---

## Tests

```bash
npm test                 # all unit/integration tests
npx vitest run path/to/file.test.ts
npm run test:solver
npm run test:collaboration
npm run check:docs
```

Guidelines:

- Test behaviour and observable state, not private methods.
- Include a degenerate or hostile case for geometry and export changes.
- Add an inverse round-trip test for every operation.
- Use `fake-indexeddb` for persistence tests.
- Keep tests deterministic: no real timers when a fake clock is sufficient, no network.
- Do not delete or weaken an assertion to make a change pass; explain intentional behaviour
  changes in the PR.

See [docs/TESTING.md](docs/TESTING.md) for the suite map and what it does not cover.

---

## Documentation

Docs are part of the deliverable:

| Change | Update |
|---|---|
| User-visible behaviour | `docs/USER-GUIDE.md`, `docs/FAQ.md` if relevant |
| Architecture/module boundaries | `docs/ARCHITECTURE.md` |
| Scripts, environment, build | `docs/DEVELOPMENT.md` |
| Tests/coverage | `docs/TESTING.md` and the README counts |
| Collaboration/protocol | `docs/COLLABORATION.md` |
| Security posture | `SECURITY.md` |
| Anything notable | `CHANGELOG.md` |

`npm run check:docs` verifies links and, with a Vitest report, the published test counts. The
README badge must match the suite that ran.

---

## Commit messages

Use an imperative subject that says what the change does, then a short body explaining why and
how it was verified. Example:

```text
Restore .keyline.json backups from the dashboard

The save-failure recovery action downloaded a snapshot that nothing could
import. Parse and validate it, assign a fresh document ID so the original is
not overwritten, and open it as "<name> (restored)".

Verified: new document-backup tests, typecheck, full suite.
```

Avoid mixing unrelated changes, and avoid "fix stuff" subjects.

---

## Reporting bugs

Include:

- what you did, what you expected, what happened,
- browser and version, OS, Node version,
- whether the production build or dev server was used,
- any console error,
- a minimal `.keyline.json` backup or SVG where possible,
- whether the document was in a collaboration room.

Do not paste tokens, credentials or private artwork. Redact file names if needed.

---

## Feature scope

In scope: precision icon workflows, geometry correctness, export quality, accessibility,
performance on realistic documents, and documentation.

Out of scope for now: 3D/CAD, mobile apps, accounts and hosted multi-tenancy, AI model
integration, and new editing paradigms that conflict with the typed-graph model.

If you are unsure, open an issue and ask before building.
