# Collaboration

How live rooms work, what the relay enforces, and where the development boundary is.

- [What it is](#what-it-is)
- [What it is not](#what-it-is-not)
- [How an edit reaches a peer](#how-an-edit-reaches-a-peer)
- [Room URLs and identity](#room-urls-and-identity)
- [Offline behaviour](#offline-behaviour)
- [Presence](#presence)
- [Relay limits and validation](#relay-limits-and-validation)
- [Configuration](#configuration)
- [Deployment boundary](#deployment-boundary)
- [Deploying beyond localhost](#deploying-beyond-localhost)
- [Threat model](#threat-model)
- [Operational checklist](#operational-checklist)
- [Known limitations](#known-limitations)

---

## What it is

A room is a Yjs document shared over a WebSocket. Edits are **semantic operations**, not pixel
diffs: every committed `OperationDescriptor` is appended to the room log and replayed through
`OperationManager` on each peer. The result is the same document state and the same undo
semantics you would get locally.

Characteristics:

- **Local-first.** The local document is authoritative for this device. Collaboration is an
  additional input, not a remote editor session.
- **Offline-capable.** `y-indexeddb` persists room state and queued edits; reconnecting
  resynchronises.
- **Deterministic recovery.** Each snapshot has a stable hash; if replay diverges, peers can
  recover the canonical state.
- **Separate local file identity.** Joining a room never replaces the ID of the file stored on
  your device.

---

## What it is not

- Not an account system. There is no sign-in, ownership or permission model.
- Not a durable backend. The bundled relay keeps rooms in memory and discards idle ones.
- Not a revocation mechanism. Closing the share switch disconnects this device only.
- Not safe for untrusted tenants without additional hardening. A room link is an edit
  capability, and peers are not authenticated.

---

## How an edit reaches a peer

```text
local tool
  └─ OperationManager.execute()  → committed change event
        ├─ local render / autosave
        └─ collaboration session
              ├─ append CollaborativeOperation to the Yjs log
              └─ y-websocket → relay → peer session
                                            └─ replay through OperationManager
```

Details:

1. Only **committed** operations are appended. Rollbacks, remote replacements and undone steps
   are not treated as new local edits.
2. Replay order is the Yjs document order, which is canonical across peers.
3. If local replay produces a different snapshot hash, the canonical snapshot replaces the local
   graph (with the local file ID preserved).
4. Undo/redo is local to the operation stack; collaboration does not merge undo histories.

Serialized room records carry `CURRENT_COLLABORATION_SCHEMA_VERSION = 6`. Legacy room snapshots
remain readable; incompatible versions surface a compatibility notice rather than silently
corrupting a document.

---

## Room URLs and identity

- The app joins a room from `?room=<name>` in the URL.
- A copied share link contains only the room parameter, not the local file identity.
- On join, the local URL records the local document ID so reloads reopen the same local file.
- Room names are limited to `[a-zA-Z0-9_-]{1,128}`. Query strings on the relay path are rejected.
- Display identity (name and colour) is stored per device under `vector-studio-collaboration-user`
  and is validated before use. It is a label, not an authentication claim.

---

## Offline behaviour

| Situation | Behaviour |
|---|---|
| Relay unreachable | Status shows **offline**; edits continue locally and queue in IndexedDB. |
| Connection restored | Queued edits synchronise; status returns to **synced**. |
| Peer disconnects | Its presence disappears; its committed edits remain. |
| Relay restarts | Rooms are gone from server memory; connected peers republish from local state on reconnect. |
| Room idle | Server drops room state after five minutes with no connections. |
| Local tab closed | Local document persists; room state remains in IndexedDB for this device. |

> The relay is a synchronisation service, **not a backup**. Treat exported files and local
> IndexedDB as the durable copy.

---

## Presence

Awareness broadcasts:

- user ID, display name and colour (validated: name ≤ 48 chars, colour `#rrggbb`),
- pointer position in document space,
- node and segment selection.

Presence is ephemeral. It is not stored in the document, exported, or retained after disconnect.
The canvas draws remote cursors and selections on a transparent overlay; the toolbar shows
connection state and collaborator avatars.

---

## Relay limits and validation

`server/collaboration-server.mjs` is intentionally small and bounded:

| Control | Value |
|---|---|
| Room path | `/collaboration/<name>`, `[a-zA-Z0-9_-]{1,128}`, no query string |
| Max concurrent connections | 128 |
| Max rooms | 100 |
| Max message payload | 8 MiB |
| Idle room retention | 5 minutes |
| Compression | Disabled (`perMessageDeflate: false`) |
| Health endpoint | `GET /health` → `{"status":"ok"}` (no room data) |
| Other HTTP routes | `404` |
| Response headers | `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` |

Origin policy:

- With `COLLABORATION_ALLOWED_ORIGINS` set, only those **exact** origins are accepted.
- Otherwise, the browser origin must match the request host. When the request arrives from a
  loopback proxy, the proxy-supplied `x-forwarded-host` is trusted; Vite overwrites that header
  on WebSocket upgrades so clients cannot forge it.
- Malformed or missing origins are rejected when an origin is present but unparsable.

Resource caps return `503` before the upgrade. Oversized messages cause a `1009` close.

---

## Configuration

| Variable | Where | Effect |
|---|---|---|
| `COLLABORATION_PORT` | runner, Vite proxy, relay | Shared port (default `1234`). |
| `COLLABORATION_HOST` | relay | Bind address (default `127.0.0.1`). |
| `COLLABORATION_ALLOWED_ORIGINS` | relay | Exact comma-separated origins for a separately exposed relay. |
| `VITE_COLLABORATION_URL` | app build | Explicit WebSocket base URL when the relay is elsewhere. |

The default browser URL is always the app's own origin with `/collaboration`. Browser code never
targets `localhost` or another port: in hosted previews and remote browsers those are not the
server.

---

## Deployment boundary

The bundled relay is a **development and preview service**. It is not an authenticated
multi-tenant backend, and the UI says so.

What that means in practice:

- **Anyone with the room link can edit.** There is no ownership check.
- **Turning sharing off disconnects this device.** Existing links and copies held by peers may
  remain usable. The dialog states this explicitly.
- **Room state is ephemeral.** Server memory only; restart or idle expiry removes it.
- **Peer operations are not a trust boundary.** A hostile peer could send malformed operations.
  Validation in the operation layer rejects many invalid states, but the relay does not provide
  authenticated isolation.
- **No audit trail.** There is no record of who changed what.

Do not represent a room as private, encrypted end-to-end, or access-controlled. It is not.

---

## Deploying beyond localhost

Production collaboration needs work that this repository intentionally does not include.

### Option A — same origin (recommended for a small team)

1. Terminate TLS at a reverse proxy.
2. Proxy `/collaboration` (with WebSocket upgrade) to the relay.
3. Keep the relay bound to loopback and let the proxy forward `Host`.
4. Set `COLLABORATION_ALLOWED_ORIGINS` to the app origin and verify the proxy overwrites
   `x-forwarded-host` rather than appending client input.
5. Replace the in-memory relay with a durable backend **or** accept ephemeral rooms explicitly.

### Option B — separate relay host

1. Run the relay behind TLS with a hardened origin allowlist.
2. Build the app with `VITE_COLLABORATION_URL=wss://relay.example/collaboration`.
3. Add the app hostname to `VITE_ALLOWED_HOSTS` if Vite preview is used.
4. Apply rate limiting, connection quotas and logging at the edge.

### Still required for a real product

- authentication and room authorisation,
- durable storage and backup,
- revocation and link expiry,
- per-user rate limits and abuse controls,
- operational monitoring,
- a privacy policy covering shared content.

None of these are implemented here. Treat any deployment without them as trusted-use only.

---

## Threat model

| Risk | Current mitigation | Remaining exposure |
|---|---|---|
| Forged origin | Exact origin allowlist or same-host check; proxy header overwrite | A compromised proxy can assert a host. |
| Oversized payload / memory abuse | 8 MiB cap, connection and room caps | No per-IP rate limit. |
| Room enumeration | Random-looking room names by convention | Names are guessable if short; no auth. |
| Malicious peer operations | Operation validation, geometry validation, export escaping | Not a formal sandbox; untrusted tenants are out of scope. |
| Link leakage | Links are not stored on a server; copied links omit local file IDs | Anyone with the link can edit. |
| Data loss on relay restart | Peers retain local Yjs state and republish | A room with no connected peer loses server state. |
| Eavesdropping | TLS when deployed behind HTTPS | The bundled dev relay is plain HTTP on loopback. |

See [SECURITY.md](../SECURITY.md) for reporting and the wider application threat model.

---

## Operational checklist

Before exposing a relay beyond your machine:

- [ ] TLS is terminated in front of the relay.
- [ ] `COLLABORATION_HOST` is loopback, or the network is otherwise restricted.
- [ ] `COLLABORATION_ALLOWED_ORIGINS` is an explicit allowlist, not `*`.
- [ ] The proxy overwrites `x-forwarded-host`.
- [ ] Connection, room and payload limits match expected use.
- [ ] Users understand that a link is an edit capability and that disconnect is not revocation.
- [ ] Export/backup guidance is documented for the team.
- [ ] Logging and rate limiting exist at the edge.

---

## Known limitations

- No authentication, authorisation, ownership or audit log.
- No server-side revocation or link expiry.
- No durable room storage; idle state expires after five minutes.
- Undo is local; histories are not merged.
- Presence is best-effort and disappears on disconnect.
- Schema compatibility is checked, but mixed-version clients are not a supported configuration.
