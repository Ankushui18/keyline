# Keyline Wasm constraint solver

A stateless, deterministic `f64` projection solver for Keyline's typed vector graph, compiled with
`wasm-pack` and called from a Web Worker.

This crate is the **independent verifier**; the synchronous TypeScript preflight lives in
`src/constraints/solver.ts`. Both must agree on the contract:

- 100 iterations maximum,
- `1e-6` default hard tolerance,
- deterministic ordering (nodes, segments and constraints are sorted before solving),
- explicit hard / medium / soft projection weights,
- no randomness and no retained state between calls.

## Build

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack      # once
npm run build:solver         # from the repository root
```

`pkg/` is committed so the app and tests can run without a Rust toolchain. Do not gitignore it;
rebuild it after changing `src/lib.rs`, and run `npm run test:solver` plus
`cargo test --manifest-path solver/Cargo.toml`.

## Boundary

The browser worker calls `solve_json`. Input and output are JSON at the Wasm boundary so entity
IDs and diagnostics stay explicit and debuggable. Native circular arcs are solved directly
(centre, radius and endpoint nodes), not through a chord proxy.

```json
{
  "nodes": [{ "id": "a", "x": 0, "y": 0 }],
  "segments": [{ "id": "s", "startNodeId": "a", "endNodeId": "b", "segmentType": "arc" }],
  "constraints": [{ "id": "c", "type": "fixed_radius", "targetIds": ["s"], "parameters": { "radius": 20 } }]
}
```

See `src/constraints/serialization.ts` for the exact schema and
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#the-two-solvers) for how the two solvers are used.
