# Vector Studio Wasm Constraint Solver

Stateless deterministic `f64` projection solver compiled with `wasm-pack`.

```bash
wasm-pack build --target web --release --out-dir pkg
```

The browser Web Worker calls `solve_json`. Input and output are JSON at the Wasm boundary so entity IDs and diagnostics remain explicit and debuggable. Geometry arrays remain deterministic because nodes, segments, and constraints are sorted before serialization.
