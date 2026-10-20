# Security policy

## Supported versions

| Version | Supported |
|---|---|
| `0.1.x` (current source) | Yes |

This is a source project without long-term support branches. Fixes land on `main`.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: open the repository's **Security** tab →
**Report a vulnerability** (private security advisory). Include:

- affected version or commit,
- a description of the issue and its impact,
- reproduction steps or a minimal proof of concept,
- any suggested fix or mitigation.

You can expect an acknowledgement, an assessment of severity, and a coordinated disclosure
timeline. Please allow time for a fix before publishing details.

## What counts as a security issue here

Keyline is a local-first browser application. The relevant trust boundaries are:

| Area | Concern |
|---|---|
| **SVG / backup import** | Malformed or hostile files causing script execution, prototype pollution, or unbounded resource use. |
| **Generated code** | Exported React/JSX/CSS/SVG interpolating untrusted values (layer names, colours, clipboard or peer data) into executable output. |
| **Export file names** | Path traversal or header injection via naming patterns and artboard names. |
| **Clipboard** | Silent failure or injection through pasted payloads. |
| **Collaboration relay** | Origin bypass, forged forwarded host, room isolation failure, payload/connection exhaustion. |
| **Persistence** | Cross-document identity confusion, or a peer snapshot overwriting another local file's identity. |
| **Dependencies** | Known vulnerabilities in shipped runtime dependencies. |

## Known boundaries (not vulnerabilities)

These are documented design limits, not defects:

- **Room links are edit capabilities.** There is no authentication, ownership or revocation in
  the bundled relay. Anyone with a link can edit. Turning sharing off only disconnects the local
  device. See [docs/COLLABORATION.md](docs/COLLABORATION.md#deployment-boundary).
- **The relay is a development/preview service.** It is not hardened for untrusted multi-tenant
  deployment. Do not expose it publicly without TLS, an explicit origin allowlist, rate limiting
  and network restrictions.
- **Files live in browser storage.** Anyone with access to the browser profile or the device can
  read them. Backups are not encrypted.
- **No end-to-end encryption.** Collaboration traffic is protected only by the transport
  (HTTPS/WSS) you deploy.
- **Imported SVG is intentionally supported.** It is parsed into geometry and styles; if you find
  a way for an import to execute script or escape the document model, that **is** a
  vulnerability — report it.

## Security practices in this repository

- Export validates and escapes runtime values, allowlists enum-like attributes, bounds numeric
  props, sanitizes names and rejects CSS declaration injection. Covered by tests.
- Collaboration uses same-origin WebSocket URLs by default; the relay validates room paths and
  origins, caps payloads, connections and rooms, and trusts `x-forwarded-host` only from a
  loopback proxy.
- Snapshot loading validates structure; corrupt or unsupported versions fail rather than
  partially applying.
- Preferences and clipboard access are wrapped so denied permissions degrade gracefully.
- Runtime dependencies are minimal and audited with `npm audit`; CI installs from the lockfile.
- The app makes **no network requests** outside collaboration. No analytics, accounts, remote
  fonts or third-party scripts.

## Privacy

Drawings are stored only in the browser's IndexedDB on the device. Nothing is uploaded unless you
join a collaboration room. See [docs/FAQ.md](docs/FAQ.md#where-are-my-files-stored).

## Scope exclusions

The following are generally out of scope unless they demonstrate a concrete exploit:

- self-XSS requiring the user to paste code into their own console,
- issues that require an already-compromised device or browser profile,
- missing hardening headers on a development server that is not exposed,
- denial of service by loading an intentionally huge local file that the user chose,
- reports that only restate the documented collaboration boundary above.

## Dependency and disclosure notes

- `npm audit` is expected to report zero known vulnerabilities at release time; review new
  advisories before deploying.
- The committed `solver/pkg/` Wasm artifact is treated as a build product. If you need
  reproducible builds for a security-sensitive deployment, rebuild it from `solver/src/lib.rs`
  with a pinned toolchain and verify the result.
- This document and [docs/AUDIT.md](docs/AUDIT.md) describe the current posture honestly; neither
  is a certification.
