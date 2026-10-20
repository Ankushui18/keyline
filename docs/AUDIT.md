# Keyline — audit and remediation

- **Date:** 20 October 2026
- **Repository:** https://github.com/Ankushui18/keyline
- **Audited commit:** `1595d82e1242a30e5517a3bd256c6152c413f9d6`
- **Status:** delivered. Findings 1–14 are fixed, with regression coverage. The final sections record
  the sidebar follow-up, the requested corrections, and the repository/documentation pass.

> The results below are a historical record. Counts in each section are the counts at the time of
> that run; the current suite is tracked in [TESTING.md](TESTING.md).

## Summary

The original project compiled and had a substantial passing geometry/solver test suite, but it could not start using its documented commands: the startup runner, collaboration server, and two smoke-test scripts were absent. The review also found data-safety, export-injection, clipboard, and accessibility defects not covered by the original tests.

The existing editor design and geometry architecture were preserved. The identified defects below have been addressed and regression coverage added. This is a practical source/runtime review, not a comprehensive penetration test or a certification of production security or accessibility.

| Verification | Before | After |
|---|---|---|
| Reproducible dependency installation | Passed | Lockfile updated for new test dependencies |
| Production build / strict TypeScript | Passed | **Passed** |
| TypeScript unit and integration tests | 254 tests / 50 files passed | **283 tests / 54 files passed** |
| `npm run dev` | Failed: missing startup script | **Starts app + relay** |
| `npm run preview` | Failed: missing startup script | **Starts production-build preview + relay** |
| `npm run test:solver` | Referenced missing file | **Passed against actual Wasm artifact** |
| `npm run test:collaboration` | Referenced missing file | **9 real WebSocket checks passed** |
| Browser regression suite | Absent | **12 flows passed in development and production-preview modes** |
| Automated WCAG A/AA checks | Contrast defects reproduced | **0 violations in 8 tested UI states** |
| `npm audit` | 0 known vulnerabilities | **0 known vulnerabilities** |

Environment: Node.js `20.20.2`, npm `10.8.2`, preinstalled Chromium/Playwright CLI.

## Findings and fixes

Severity describes the impact in this application, not a formal CVSS score.

| # | Severity | Finding | Remediation / evidence |
|---|---|---|---|
| 1 | Blocker | Documented dev, preview, collaboration, and smoke-test commands referenced missing files. | Added the coordinated startup runner, bounded Yjs relay, Wasm smoke test, and WebSocket test script. Both dev and production preview were started and exercised. |
| 2 | High — availability | Collaboration tried to contact browser localhost or a sibling preview port instead of the already-configured app proxy. | Default WebSockets now use the app's origin and `/collaboration`. Explicit external relay configuration remains supported. Added URL regression tests and two-browser verification. |
| 3 | High — data safety | Loading a peer snapshot replaced the local document ID with the peer's ID, contradicting the promise that joining a room creates a separate local file. | Shared snapshots now preserve the local file identity. Joining records that ID in the local URL while copied links contain only the room parameter. Unit and isolated-browser checks verify distinct IDs with identical shared content. |
| 4 | Medium — synchronization | Snapshot hashes distinguished absent optional properties from properties containing `undefined`, even though JSON transport removes the latter. | Stable object hashing now follows JSON omission semantics. Regression tests cover a snapshot before/after JSON transport and avoid repeated remote replacements of equivalent content. |
| 5 | High — conditional injection | Generated React exports interpolated runtime titles and colors directly into SVG markup. Dollar-sign replacement directives and colliding/reserved export names were also unsafe. | XML-escape runtime attribute values, use callback replacements, alias/disambiguate exported props, clamp exposed numeric values, and reject CSS declaration injection. Tests compile and execute the generated component with hostile values. |
| 6 | High — conditional injection | SVG previews/export interpolated typed stroke cap/join values without runtime validation; malformed peer or clipboard data could escape an attribute. | Allowlist stroke cap/join and fill-rule enums at SVG emission. Added a malformed-appearance regression test. Color attributes were already XML-escaped. |
| 7 | Medium — data safety | Autosaves could overlap, report an older revision as saved, and mix mutable geometry with asynchronous thumbnail/storage work. Pending edits relied solely on a 500 ms timer. | Serialize revision-aware saves, freeze each saved snapshot, avoid retaining obsolete thumbnails, and perform best-effort flushes on visibility loss/pagehide. Added IndexedDB save/rename/duplicate/delete, overlap, lifecycle, debounce, and retry tests. |
| 8 | High — availability | Multiple unguarded localStorage calls could crash the editor in restricted browser contexts; malformed saved collaboration identities were trusted. | Centralized safe preference access with in-memory fallback and validated stored identities. Unit tests cover denied access/quota exhaustion; a browser with localStorage blocked can still draw and open Share. |
| 9 | Medium — reliability | Copy actions could throw or reject without handling; Share displayed “Copied” even when no text was written. | Added a permission-safe clipboard helper, explicit failure feedback, truthful success labels, and room-only copied URLs. Browser checks deny clipboard access and verify the fallback UI. |
| 10 | Medium — accessibility | Share, Settings, command search, and Motion lacked consistent focus containment/background isolation. Command search was missing an explicit accessible label. | Added shared modal focus management, inert backgrounds, Tab/Shift+Tab containment, opener restoration, and search labels. Existing Export focus handling was preserved. |
| 11 | Medium — accessibility | Export/primary buttons, hidden layer names, avatars, and Motion timing labels had insufficient text contrast. | Adjusted foreground/background colors and added luminance-based avatar text colors. Automated checks pass for editor, export, share, share with a peer, settings, command search, Motion, and files dashboard. |
| 12 | Medium — security expectations | Turning off sharing claimed the drawing was private again even though no server-side link revocation or ownership enforcement existed. | Corrected UI/documentation: turning off sharing disconnects this device; existing links/copies may remain usable. Removed the unsupported “Owner” label. Actual authentication and revocation remain production deployment work, described below. |
| 13 | Medium — development hardening | Vite accepted every Host header, and the missing relay had no enforceable resource/origin policy. | Replaced wildcard hosts with an Arena-compatible allowlist plus configurable additions. The relay validates room paths and origins, caps messages/connections/rooms, and expires idle rooms. Vite overwrites forwarded host values on upgrades so clients cannot forge them. |
| 14 | Low — maintenance | Generated compiler caches and a Vite log were tracked; no repeatable whole-project check or CI workflow was present. | Added `.gitignore`, removed generated artifacts from tracking, declared Node compatibility, added `typecheck`/`check`/browser commands, and added read-only GitHub Actions application/Rust jobs. |

### Key implementation files

- `scripts/run-with-collaboration.mjs` — starts/stops both services, propagates failures, forwards Vite arguments.
- `server/collaboration-server.mjs` — development relay, health check, origin/path validation, resource limits, idle cleanup.
- `src/collaboration/session.ts` — same-origin transport, file isolation, transport-stable hashes, disposed-session guard.
- `src/core/store.ts` — immutable save revisions, serialized writes, lifecycle flushes.
- `src/core/preferences.ts` and `src/core/browser-clipboard.ts` — optional-browser-capability handling.
- `src/export/code-export.ts` and `src/export/svg-export.ts` — export trust boundaries.
- `src/ui/use-modal-focus.ts` and `src/ui/contrast-color.ts` — modal behavior and avatar contrast.
- `.github/workflows/ci.yml` — repeatable application checks and native Rust test job.

## Verification evidence

### Build, tests, and dependency audit

```bash
npm ci
npm run check
npm audit
```

`npm run check` runs the production build (including strict TypeScript), the 283-test suite, the real Wasm smoke test, and 9 WebSocket integration checks.

Evidence:

- `audit/check-final.log`
- `audit/dependencies-baseline.json`
- `audit/dependencies-final.json`

The WebSocket checks cover health, synchronization, offline/reconnect convergence, room isolation, invalid paths, origin policy, explicit origin allowlists, oversized payload rejection, and idle cleanup.

### Browser verification

The 12-flow browser suite was run against **both**:

- Development app on port `5173` with relay `1234`.
- Production-build preview on port `4173` with relay `1235`.

It verifies sample creation, undo/redo, rename/autosave/reload, SVG download, React preview, denied clipboard access, modal keyboard behavior, distinct local shared-file IDs, live semantic edits, concurrent offline edits/reconnect, settings/search/Motion, dashboard, and blocked localStorage. No unhandled page errors were recorded. Expected socket disconnects during the offline test are not application failures.

Evidence:

- `audit/browser-results-development.json`
- `audit/browser-results-production.json`
- `audit/editor-final.png`
- `audit/sample-export.svg`

Additional HTTP/WebSocket probes verified that both app modes reject untrusted Host headers, accept Arena preview hosts, support HTTPS preview origins through the proxy, and reject forged forwarded-host attempts. See `audit/host-and-proxy-checks.json`.

To rerun browser checks where the Playwright CLI and Chromium are already available:

```bash
# Keep npm run dev running in another terminal.
playwright-cli -s=arena open http://127.0.0.1:5173 --browser=chromium
npm run test:browser
playwright-cli -s=arena close
```

## Running the preview

The **Keyline editor** live preview is left running on `0.0.0.0:5173`, with its loopback relay on port `1234`:

```bash
cd /home/user/keyline
npm run dev -- --port 5173
```

The separate production-check process was stopped after successful verification. For a local production-build preview:

```bash
npm run build
npm run preview
```

Use the platform's Live Preview rather than trying to reach the sandbox's localhost from another device. Browser-facing collaboration uses a relative/same-origin proxy path.

## Remaining boundaries and follow-ups

1. **Not a production collaboration backend.** The included relay intentionally supports development/preview. Links are edit capabilities, not authenticated accounts. Production needs TLS, authentication/authorization where required, durable room storage, rate/total-room-size limits, and a real revocation policy. The current relay retains idle room state in memory for five minutes; restart or expiry clears server state. Peers retain local IndexedDB state and can republish it. Payload and connection caps do not make hostile-peer operation streams safe for an untrusted multi-tenant deployment.
2. **Native Rust verification was unavailable in this sandbox.** Cargo/rustc/wasm-pack were not installed. The existing compiled Wasm artifact passed the real smoke test and TypeScript/Wasm parity test. The newly added native Rust CI job has not been executed here; source-to-artifact reproducibility is not claimed.
3. **Accessibility coverage is scoped.** Zero automated violations in the eight tested desktop Chromium UI states is not a complete WCAG conformance claim, screen-reader audit, or verification of every dialog/tool/state.
4. **Performance/maintainability follow-up.** Main JS is approximately 340.6 kB (94.5 kB gzip), shared vendor JS 355.5 kB (115.6 kB gzip), and CSS 226.9 kB (39.1 kB gzip). Large editor/inspector modules and layered historical stylesheets merit a separate modularization/bundle-budget pass. No risky renderer or geometry rewrite was attempted as part of these fixes.
5. **Browser persistence remains best effort.** Blocked/full IndexedDB or abrupt process termination can still prevent persistence. The editor reports save failures and offers a downloadable copy; lifecycle flushes cannot guarantee a write after an immediate browser kill.

## Delivery

All fixes, tests, and documentation are committed to the repository. Evidence files produced by the
browser suites are written to `audit/`, which is intentionally ignored by Git because it contains
generated screenshots and logs; the results are summarised here.


## Follow-up: palette, icons and icon-start correction — 20 October 2026

The requested **Layers above Design** layout, divider, independent scrolling and compact controls are retained, but the unrequested sidebar recoloring has been reverted to the existing theme tokens (surface `#1f2023`, fields `#17181a`, existing blue `#0d99ff`). The original Add fill default is restored; existing document colors are not rewritten.

- Fixed Undo/Redo's excessive size and weight: 16px filled Octicons, no added CSS stroke, unchanged 32px click targets.
- Fixed the doubled Move/Select cursor outline by using the filled glyph as authored instead of stroking both contours; rail glyphs are 18px. Custom primary line-tool SVGs retain their strokes.
- First icon start now adopts the exact pristine starter rather than appending a small frame beside a 1024×768 default. Subsequent deliberately created blank frames are all listed and counted.
- Local older icon-only documents with the exact untouched starter plus generated icon frames receive conservative, undoable cleanup after persistence subscribes. Customized/populated frames and shared-room startup are not auto-cleaned.
- Empty chosen frames survive reload without reopening first-visit onboarding.

Latest verification (not the initial audit counts above):

| Check | Result |
|---|---|
| Strict TypeScript + production build | Passed |
| TypeScript unit/integration suite | **312 tests / 56 files passed** |
| Compiled Wasm smoke test | Passed; not a native Rust source rebuild |
| Real WebSocket relay integration | **9 / 9 passed** |
| Focused correction browser suite | **13 / 13 passed**, 3 automated accessibility states, no runtime errors |
| Layers/Design browser suite | **17 / 17 passed**, 5 automated accessibility states, no runtime errors |
| Existing end-to-end browser suite | **12 / 12 passed**, 8 automated accessibility states |

Evidence: `audit/review-check.log`, `audit/review-results.json`, `audit/design-sidebar-results.json`, `audit/browser-results.json` and `audit/review-icon-start.png`. Automated checks are scoped regression coverage, not full accessibility certification.

The corrected source supersedes the earlier standalone sidebar patch. The earlier patch predates
this follow-up and should not be applied on top of the current tree.

## Repository and documentation pass — 20 October 2026

A follow-up pass addressed repository hygiene and documentation. No editing behaviour changed.

### Fixed

| # | Finding | Fix |
|---|---|---|
| 15 | The repository had **no `.gitignore`**, despite finding 14 claiming one was added. `node_modules/`, `dist/`, browser audit output and caches were only untracked by convention. | Added `.gitignore` covering dependencies, build output, audit artefacts, TypeScript caches, logs, Rust target output, environment files and OS/editor files. |
| 16 | Generated `tsconfig.app.tsbuildinfo`, `tsconfig.node.tsbuildinfo` and `vite.log` were tracked. | Removed from Git and ignored; `.gitattributes` marks generated lockfiles/pkg as generated and keeps binary assets untouched. |
| 17 | No license file, contribution guide, security policy or changelog existed. | Added MIT `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`. |
| 18 | There was no CI workflow, so the documented "read-only GitHub Actions jobs" did not exist. | Added `.github/workflows/ci.yml`: lockfile install, strict TypeScript + build, unit/integration suite, Wasm smoke test, WebSocket suite, Rust tests, documentation check. |
| 19 | README was a phase report rather than an entry point; deep detail was mixed with setup, and the product name alternated between "Vector Studio" and "Keyline". | Rebuilt README as a landing page (what/why, 2-minute start, feature map, repository map, doc index, quality gates, honest limits). Package metadata and solver descriptions now use Keyline; legacy storage keys are documented as intentional. |
| 20 | The save-failure recovery action downloaded a `.keyline.json` snapshot that **nothing could import**, so the advertised backup was not restorable. | Added validated backup parsing (`src/core/document-backup.ts`), dashboard import for `.keyline.json`, and restore as a new file with a fresh ID so the original is never overwritten. Five new tests cover acceptance, round-trip, naming and malformed input. |
| 21 | Documentation could drift silently: no link checking, and test counts were maintained by hand. | Added `scripts/check-docs.mjs` and `npm run check:docs`; CI compares the README badge and documented counts against a real Vitest JSON report. |

### Documentation added

`docs/ARCHITECTURE.md`, `docs/USER-GUIDE.md`, `docs/DEVELOPMENT.md`, `docs/TESTING.md`,
`docs/COLLABORATION.md`, `docs/FAQ.md`, this audit record, plus hand-authored SVG assets
(`docs/assets/banner.svg`, `docs/assets/data-flow.svg`). All relative links and required files are
checked in CI.

### Verification for this pass

| Check | Result |
|---|---|
| Strict TypeScript + production build | Passed (`tsc -b`, `vite build`) |
| Unit/integration suite | **341 tests / 58 files passed** |
| Wasm smoke test | Passed against the committed artifact |
| WebSocket relay integration | **9 / 9 passed** |
| Rust tests | Not run in this sandbox (no Rust toolchain); CI job added |
| Documentation check | Passed (links, required files, tracked artifacts, counts) |
| Browser suites | Not re-run in this pass (no Playwright CLI session in the sandbox) |

The six tests added by the backup-restore fix (five parser/round-trip cases plus one IndexedDB
restore integration case) are the only change to the suite size in this pass.
