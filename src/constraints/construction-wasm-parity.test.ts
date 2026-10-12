import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import initWasm, { solve_json, solver_version } from '../../solver/pkg/vector_solver.js';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Constraint, Point, Segment, VectorNode, VectorPath } from '../core/types';
import {
  deserializeSolverOutput,
  serializeSolverInput,
  type SerializedSolverOutput,
} from './serialization';
import { DeterministicConstraintSolver } from './solver';

function addLine(
  document: VectorDocument,
  manager: OperationManager,
  startPosition: Point,
  endPosition: Point,
  role: Segment['role'],
): { start: VectorNode; end: VectorNode; segment: Segment } {
  const start: VectorNode = { id: createEntityId(), position: startPosition, constraintIds: [] };
  const end: VectorNode = { id: createEntityId(), position: endPosition, constraintIds: [] };
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
  const segment: Segment = {
    id: createEntityId(), startNodeId: start.id, endNodeId: end.id,
    type: 'line', role,
    constructionExtent: role === 'construction' ? 'infinite' : undefined,
  };
  manager.beginTransaction('Wasm parity fixture');
  manager.execute({ type: 'ADD_NODE', payload: { node: start, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_NODE', payload: { node: end, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { start, end, segment };
}

describe('TypeScript/Wasm construction constraint parity', () => {
  it('converges identically when geometry is perpendicular to a pinned construction line', async () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const construction = addLine(document, manager, { x: 0, y: 0 }, { x: 100, y: 0 }, 'construction');
    const geometry = addLine(document, manager, { x: 20, y: 20 }, { x: 80, y: 60 }, 'geometry');
    const perpendicular: Constraint = {
      id: createEntityId(),
      type: 'perpendicular',
      priority: 'hard',
      targetIds: [construction.segment.id, geometry.segment.id],
      tolerance: 1e-6,
    };
    document._addConstraint(perpendicular);
    const pinned = [construction.start.id, construction.end.id];
    const input = serializeSolverInput(document, pinned);
    expect(input.segments.find((segment) => segment.id === construction.segment.id)).toMatchObject({
      role: 'construction', constructionExtent: 'infinite',
    });

    const typescript = new DeterministicConstraintSolver().solve(document, { pinnedNodeIds: pinned });
    const wasmBytes = await fs.readFile(new URL('../../solver/pkg/vector_solver_bg.wasm', import.meta.url));
    await initWasm({ module_or_path: wasmBytes });
    const raw = JSON.parse(solve_json(JSON.stringify(input))) as SerializedSolverOutput;
    const wasm = deserializeSolverOutput(raw, document);

    expect(solver_version()).toContain('deterministic-f64');
    expect(typescript.success).toBe(true);
    expect(wasm.success).toBe(true);
    expect(wasm.iterations).toBe(typescript.iterations);
    for (const [nodeId, expected] of typescript.adjustedNodes) {
      const actual = wasm.adjustedNodes.get(nodeId)!;
      expect(actual.x).toBeCloseTo(expected.x, 9);
      expect(actual.y).toBeCloseTo(expected.y, 9);
    }
    const constructionStart = wasm.adjustedNodes.get(construction.start.id)!;
    const constructionEnd = wasm.adjustedNodes.get(construction.end.id)!;
    expect(constructionStart).toEqual({ x: 0, y: 0 });
    expect(constructionEnd).toEqual({ x: 100, y: 0 });
    expect(document.getSegment(construction.segment.id)).toMatchObject({
      role: 'construction', constructionExtent: 'infinite',
    });
  });
});
