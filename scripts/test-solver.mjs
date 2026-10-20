import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { solve_json, solver_version } from '../solver/pkg/vector_solver.js';

await init({ module_or_path: await readFile(new URL('../solver/pkg/vector_solver_bg.wasm', import.meta.url)) });
assert.match(solver_version(), /deterministic-f64/);
const input = {
  nodes: [{ id: 'a', x: 10, y: 0 }, { id: 'b', x: 0, y: 10 }],
  segments: [{ id: 'arc', startNodeId: 'a', endNodeId: 'b', segmentType: 'arc', center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, clockwise: false }],
  constraints: [{ id: 'radius', type: 'fixed_radius', priority: 'hard', targetIds: ['arc'], parameters: { radius: 20 }, tolerance: 1e-6 }],
  pinnedNodeIds: [], tolerance: 1e-6, maxIterations: 100,
};
const solved = JSON.parse(solve_json(JSON.stringify(input)));
assert.equal(solved.success, true);
assert.equal(solved.adjustedSegments[0].radius, 20);
assert.ok(Math.abs(solved.adjustedNodes.find((node) => node.id === 'a').x - 20) < 1e-9);
assert.ok(Math.abs(solved.adjustedNodes.find((node) => node.id === 'b').y - 20) < 1e-9);
const invalid = structuredClone(input);
invalid.segments[0].segmentType = 'line';
assert.equal(JSON.parse(solve_json(JSON.stringify(invalid))).success, false);
assert.equal(JSON.parse(solve_json('{invalid json')).success, false);
assert.equal(solve_json(JSON.stringify(input)), solve_json(JSON.stringify(input)));
console.log(`Wasm smoke test passed (${solver_version()}): native arcs, invalid geometry, malformed input, determinism.`);
