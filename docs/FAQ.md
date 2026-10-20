# FAQ

Short answers to the questions that come up first.

- [Is Keyline free?](#is-keyline-free)
- [Is this a Figma plugin or a website?](#is-this-a-figma-plugin-or-a-website)
- [Do I need an account or internet access?](#do-i-need-an-account-or-internet-access)
- [Where are my files stored?](#where-are-my-files-stored)
- [How do I back up or restore a drawing?](#how-do-i-back-up-or-restore-a-drawing)
- [Can I open Figma, Sketch or Illustrator files?](#can-i-open-figma-sketch-or-illustrator-files)
- [Can I get my work into Figma?](#can-i-get-my-work-into-figma)
- [Is anything sent to a server?](#is-anything-sent-to-a-server)
- [Is "Ask for an edit" an AI feature?](#is-ask-for-an-edit-an-ai-feature)
- [Why are there two renderers?](#why-are-there-two-renderers)
- [Why is a compiled Wasm file committed?](#why-is-a-compiled-wasm-file-committed)
- [Why does the Node version matter?](#why-does-the-node-version-matter)
- [Why do my icons look blurry at 1×?](#why-do-my-icons-look-blurry-at-1)
- [Why does sharing stay active after I turn it off?](#why-does-sharing-stay-active-after-i-turn-it-off)
- [Can several people edit at once?](#can-several-people-edit-at-once)
- [Why is "Saved" sometimes delayed?](#why-is-saved-sometimes-delayed)
- [How do I reset the app?](#how-do-i-reset-the-app)
- [How do I update Keyline?](#how-do-i-update-keyline)
- [Does it work offline?](#does-it-work-offline)
- [Which browsers are supported?](#which-browsers-are-supported)
- [Why do the docs mention tests that do not run in CI?](#why-do-the-docs-mention-tests-that-do-not-run-in-ci)
- [Can I use the output commercially?](#can-i-use-the-output-commercially)

---

## Is Keyline free?

Yes. The source is [MIT licensed](../LICENSE) and free for personal and commercial use.

---

## Is this a Figma plugin or a website?

Neither exactly: it is a **local web application**. You clone the repository, run it with Node,
and use it in your browser. There is no hosted version and no plugin runtime.

---

## Do I need an account or internet access?

No account, ever. Internet access is only needed the first time to install dependencies.

After `npm ci && npm run build`, the production build is static and works entirely offline
(except joining a collaboration room, which needs the relay).

---

## Where are my files stored?

Three local places, all scoped to the origin you serve the app from:

| What | Where |
|---|---|
| Drawings, thumbnails, file names | IndexedDB database **`vector-studio`**, table `documents` |
| Preferences (renderer, sidebar width, drawing style, motion, identity) | `localStorage` keys beginning `vector-studio-` or `keyline-` |
| Collaboration room state | IndexedDB, managed by `y-indexeddb` |

Consequences:

- Files do **not** sync between browsers, profiles, devices or ports.
- `http://localhost:5173` and `http://127.0.0.1:5173` are different origins with separate data.
- Clearing site data deletes your files. Export a backup first.
- Private/incognito storage may be discarded when the window closes.
- Blocked or full storage prevents saving; the app then offers a recovery download.

The legacy `vector-studio` database name is intentional. Renaming it would orphan existing files.

---

## How do I back up or restore a drawing?

- **Normal backup:** use **Export** for SVG/PNG, or **Export set** for a ZIP of artboards.
- **Recovery backup:** if saving fails, the status bar offers **Download a copy**. That writes a
  `.keyline.json` file containing the full document snapshot.
- **Restore:** on the dashboard, choose **Import** (or drop the file anywhere) and select the
  `.keyline.json`. It is validated, opened as a **new file** named `<name> (restored)`, and saved
  locally. The original file is never overwritten.

Backups are not encrypted. Treat them like any other design file.

---

## Can I open Figma, Sketch or Illustrator files?

No. Import supports **SVG** only (plus Keyline's own `.keyline.json` backups). Convert other
formats to SVG first.

---

## Can I get my work into Figma?

Yes, as vectors: export SVG and place or paste it into Figma. Figma will treat it as paths and
shapes, not as Keyline constraints or regions. Parametric instances are materialized on export.

For code, export the React component or CSS variables and commit the generated file.

---

## Is anything sent to a server?

No, with one deliberate exception: **collaboration**. When you join a room, Yjs traffic goes to
the same-origin `/collaboration` endpoint. Everything else — drawing, solving, persistence,
export, and the command bar — runs in your browser.

There are no analytics, telemetry, accounts, remote fonts or third-party requests at runtime.
Fonts are bundled in `src/assets/`.

---

## Is "Ask for an edit" an AI feature?

No. It is a deterministic phrase reader for a small set of appearance edits (`thinner`,
`line 1.5`, `round ends`, `no fill`, `line color black`, `opacity 60%`, …). It runs on-device,
has no model, and refuses anything it cannot parse instead of guessing.

The Settings panel states this explicitly under **AI and connections**.

---

## Why are there two renderers?

- **Canvas 2D** is the compatibility path and handles every feature.
- **WebGL2** batches large drawings and culls off-screen geometry for performance.

Both read the same document and produce the same hit-testing results. Switch in
**Settings → Performance → Drawing engine**, or with the toolbar control. If WebGL2 is
unavailable, the app falls back to Canvas instead of failing.

---

## Why is a compiled Wasm file committed?

The constraint solver has two implementations: TypeScript for synchronous preflight, and Rust
compiled to WebAssembly for independent verification in a worker. Committing `solver/pkg/` means
contributors can run and test the app **without installing Rust**. It is a build artifact by
design, not an accident. See [DEVELOPMENT.md](DEVELOPMENT.md#rebuilding-the-rustwasm-solver).

---

## Why does the Node version matter?

The toolchain is Vite 7, which requires Node **20.19+ or 22.12+**. Some earlier Node 20 releases
satisfy `>=20` but fail at startup. Use Node 22 LTS if unsure.

---

## Why do my icons look blurry at 1×?

Odd stroke widths and bounds that land on whole-pixel rather than half-pixel positions blur when
rasterized at 1×. **Check icons** (`Ctrl/⌘ ⇧ C`) reports a **Grid** check for this. Use the fix,
align bounds to half pixels, or export at 2×/3×.

---

## Why does sharing stay active after I turn it off?

Because a room link is a capability, not an account session. Turning sharing off **disconnects
this device**; it cannot revoke a URL that a peer already has, nor delete their local copy. The
dialog says this. There is no server-side revocation in the bundled relay. See
[COLLABORATION.md](COLLABORATION.md#deployment-boundary).

---

## Can several people edit at once?

Yes, within the relay's limits (128 connections, 100 rooms, 8 MiB messages). Edits are exchanged
as operations and replayed deterministically. Presence shows cursors and selections.

This is intended for trusted collaborators on a development/preview relay, not for untrusted
tenants. Undo histories are local and not merged.

---

## Why is "Saved" sometimes delayed?

Saves are debounced by 500 ms and serialized so an older save cannot overwrite a newer one.
The indicator shows **Saving…** until the write completes. Switching tabs or closing the page
triggers a best-effort flush, but an abrupt process kill can still lose the last fraction of a
second.

---

## How do I reset the app?

1. Export anything you want to keep (backup or SVG).
2. In the browser's site settings for the app origin, clear site data / IndexedDB.
3. Reload. You get a fresh dashboard and default preferences.

To remove only preferences but keep files, delete the `localStorage` keys listed above. There is
no in-app "erase everything" button by design; deletion is per file from the dashboard.

---

## How do I update Keyline?

```bash
git pull
npm ci
npm run dev
```

Stored documents remain compatible: snapshots 1–6 are migrated on load. If you deploy a build,
serve the new `dist/` and keep the same origin so IndexedDB stays reachable.

---

## Does it work offline?

The built app does. There is no service worker, so there is no installable PWA or offline
bootstrap for the first visit; the browser's normal HTTP cache applies.

---

## Which browsers are supported?

Current desktop Chromium-class browsers are the tested target (Chrome, Edge, Chromium). Firefox
and Safari are expected to work but are not part of the recorded test runs. WebGL2 is optional.
Touch-first and mobile layouts are not tested.

---

## Why do the docs mention tests that do not run in CI?

The browser suites require a preinstalled Playwright CLI and an open browser session, which CI
does not provide. All unit, integration, Wasm, WebSocket, Rust and documentation checks **do**
run in CI. The distinction, and the last recorded browser results, are in
[TESTING.md](TESTING.md) and [AUDIT.md](AUDIT.md).

---

## Can I use the output commercially?

Yes. The code is MIT, and artwork you create is yours. There is no license header requirement on
exported SVG or generated React components.
