import { describe, expect, it, vi } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { ConstraintViolationError, OperationManager } from '../core/operations';
import type { Constraint, Point, Segment, VectorNode, VectorPath } from '../core/types';
import { deserializeSolverOutput, serializeSolverInput } from './serialization';

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
    id: createEntityId(),
    startNodeId: start.id,
    endNodeId: end.id,
    type: 'line',
    role,
    constructionExtent: role === 'construction' ? 'infinite' : undefined,
  };
  manager.beginTransaction('Constraint line fixture');
  manager.execute({ type: 'ADD_NODE', payload: { node: start, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_NODE', payload: { node: end, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { start, end, segment };
}

function hardConstraint(
  type: Constraint['type'],
  targetIds: string[],
  parameters?: Record<string, number>,
): Constraint {
  return {
    id: createEntityId(),
    type,
    targetIds,
    parameters,
    priority: 'hard',
    tolerance: 1e-6,
  };
}

function solvedFixture(type: Constraint['type'], construction: boolean): {
  points: Point[];
  semantic: Pick<Segment, 'role' | 'constructionExtent'>;
} {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const first = addLine(
    document,
    manager,
    type === 'symmetric' ? { x: -15, y: 7 } : { x: 0, y: 0 },
    type === 'symmetric' ? { x: 25, y: 12 } : { x: 20, y: 10 },
    construction ? 'construction' : 'geometry',
  );
  let targetIds: string[];
  let parameters: Record<string, number> | undefined;
  let second: ReturnType<typeof addLine> | undefined;

  if (type === 'horizontal' || type === 'vertical') {
    targetIds = [first.segment.id];
  } else if (type === 'fixed_distance') {
    targetIds = [first.start.id, first.end.id];
    parameters = { distance: 14 };
  } else if (type === 'coincident') {
    targetIds = [first.start.id, first.end.id];
  } else if (type === 'symmetric') {
    targetIds = [first.start.id, first.end.id];
    parameters = { axisX: 0, axisY: 0, axisAngle: 90 };
  } else {
    second = addLine(document, manager, { x: 5, y: 30 }, { x: 17, y: 52 }, 'geometry');
    targetIds = [first.segment.id, second.segment.id];
    if (type === 'fixed_angle') parameters = { angle: 60 };
  }

  manager.execute({
    type: 'ADD_CONSTRAINT',
    payload: { constraint: hardConstraint(type, targetIds, parameters) },
  });
  const current = document.getSegment(first.segment.id)!;
  const nodes = [first.start.id, first.end.id, ...(second ? [second.start.id, second.end.id] : [])]
    .map((nodeId) => ({ ...document.getNode(nodeId)!.position }));
  return {
    points: nodes,
    semantic: { role: current.role, constructionExtent: current.constructionExtent },
  };
}

function expectSamePoints(first: Point[], second: Point[]): void {
  expect(first).toHaveLength(second.length);
  first.forEach((point, index) => {
    expect(point.x).toBeCloseTo(second[index].x, 8);
    expect(point.y).toBeCloseTo(second[index].y, 8);
  });
}

describe('construction constraint semantics', () => {
  it.each([
    'horizontal',
    'vertical',
    'parallel',
    'perpendicular',
    'equal_length',
    'fixed_angle',
    'fixed_distance',
    'coincident',
    'symmetric',
  ] as const)('solves %s identically for geometry and construction lines', (type) => {
    const geometry = solvedFixture(type, false);
    const construction = solvedFixture(type, true);
    expectSamePoints(construction.points, geometry.points);
    expect(construction.semantic).toEqual({ role: 'construction', constructionExtent: 'infinite' });
  });

  it('merges numeric solver output with authoritative construction metadata', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 0 }, { x: 20, y: 0 }, 'construction');
    const serialized = serializeSolverInput(document);
    expect(serialized.segments.find((segment) => segment.id === line.segment.id)).toMatchObject({
      role: 'construction',
      constructionExtent: 'infinite',
    });

    const solverSegment = {
      id: line.segment.id,
      startNodeId: line.start.id,
      endNodeId: line.end.id,
      type: 'line',
    } as Segment;
    const merged = deserializeSolverOutput({
      success: true,
      adjustedNodes: [],
      adjustedSegments: [solverSegment],
      error: 0,
      iterations: 1,
      conflicts: [],
    }, document).adjustedSegments!.get(line.segment.id)!;
    expect(merged.role).toBe('construction');
    expect(merged.constructionExtent).toBe('infinite');
  });

  it('rejects conflicting hard construction constraints before commit and emits diagnostics', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 0 }, { x: 20, y: 10 }, 'construction');
    const horizontal = hardConstraint('horizontal', [line.segment.id]);
    const vertical = hardConstraint('vertical', [line.segment.id]);
    const diagnostics = vi.fn();
    manager.setDiagnosticsListener(diagnostics);
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: horizontal } });

    expect(() => manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: vertical } }))
      .toThrow(ConstraintViolationError);
    expect(document.constraints.has(horizontal.id)).toBe(true);
    expect(document.constraints.has(vertical.id)).toBe(false);
    expect(document.getSegment(line.segment.id)).toMatchObject({
      role: 'construction', constructionExtent: 'infinite',
    });
    expect(diagnostics).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({
        constraintIds: expect.arrayContaining([horizontal.id, vertical.id]),
        message: expect.stringContaining('horizontal and vertical'),
      }),
    ]));
  });
});
