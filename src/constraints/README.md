# Constraint runtime

`solver.ts` is the synchronous deterministic projection core used for transactional pre-validation. `solver-worker.ts` loads the Rust-generated Wasm module and independently verifies committed systems off the main thread. Both use the same 100-iteration, `1e-6` convergence contract and hard/medium/soft priority semantics.

Keeping the preflight core synchronous prevents tentative invalid graph state from becoming visible. Keeping the full Wasm verification in a Worker provides an isolated numerical runtime and a forward path to move the complete asynchronous commit pipeline off-thread as document sizes grow.

Architecture and the shared numeric contract are documented in
[../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#the-two-solvers). The Rust crate lives in
[`solver/`](../../solver/README.md).
