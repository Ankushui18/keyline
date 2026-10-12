import { describe, expect, it, vi } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { ConstraintViolationError, OperationManager } from '../core/operations';
import type { Constraint, Point, Segment, VectorNode, VectorPath } from '../core/types';
import { DeterministicConstraintSolver } from './solver';

function addLine(
  document: VectorDocument,
  manager: OperationManager,
  start: Point,
  end: Point,
): { start: VectorNode; end: VectorNode; segment: Segment } {
  const networkId = document.activeNetwork.id;
  const a: VectorNode = { id: createEntityId(), position: start, constraintIds: [] };
  const b: VectorNode = { id: createEntityId(), position: end, constraintIds: [] };
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
  const segment: Segment = { id: createEntityId(), startNodeId: a.id, endNodeId: b.id, type: 'line', role: 'geometry' };
  manager.beginTransaction('Line');
  manager.execute({ type: 'ADD_NODE', payload: { node: a, networkId } });
  manager.execute({ type: 'ADD_NODE', payload: { node: b, networkId } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { start: a, end: b, segment };
}

function constraint(type: Constraint['type'], targetIds: string[], parameters?: Record<string, number>): Constraint {
  return { id: createEntityId(), type, targetIds, parameters, priority: 'hard', tolerance: 1e-6 };
}

describe('deterministic constraint solver', () => {
  it('maintains horizontal geometry through transactional node movement', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 0 }, { x: 100, y: 20 });
    const horizontal = constraint('horizontal', [line.segment.id]);
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: horizontal } });
    expect(document.getNode(line.start.id)?.position.y).toBeCloseTo(document.getNode(line.end.id)!.position.y, 8);

    const before = document.getNode(line.start.id)!.position.y;
    manager.execute({ type: 'MOVE_NODE', payload: { nodeId: line.start.id, delta: { x: 0, y: 25 } } });
    expect(document.getNode(line.start.id)?.position.y).toBeCloseTo(before + 25, 8);
    expect(document.getNode(line.end.id)?.position.y).toBeCloseTo(before + 25, 8);
    manager.undo();
    expect(document.getNode(line.start.id)?.position.y).toBeCloseTo(before, 8);
    expect(document.getNode(line.end.id)?.position.y).toBeCloseTo(before, 8);
  });

  it('undoes and redoes a constraint together with its solved geometry', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 0 }, { x: 100, y: 30 });
    const horizontal = constraint('horizontal', [line.segment.id]);
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: horizontal } });
    expect(document.constraints.has(horizontal.id)).toBe(true);
    expect(document.getNode(line.start.id)?.position.y).toBeCloseTo(15, 8);
    manager.undo();
    expect(document.constraints.has(horizontal.id)).toBe(false);
    expect(document.getNode(line.start.id)?.position.y).toBeCloseTo(0, 8);
    expect(document.getNode(line.end.id)?.position.y).toBeCloseTo(30, 8);
    manager.redo();
    expect(document.constraints.has(horizontal.id)).toBe(true);
    expect(document.getNode(line.end.id)?.position.y).toBeCloseTo(15, 8);
  });

  it('maintains fixed distance while preserving the dragged node', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 0 }, { x: 40, y: 0 });
    manager.execute({
      type: 'ADD_CONSTRAINT',
      payload: { constraint: constraint('fixed_distance', [line.start.id, line.end.id], { distance: 20 }) },
    });
    manager.execute({ type: 'MOVE_NODE', payload: { nodeId: line.start.id, delta: { x: 10, y: 10 } } });
    const a = document.getNode(line.start.id)!.position;
    const b = document.getNode(line.end.id)!.position;
    expect(a).toEqual({ x: 20, y: 10 });
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(20, 8);
  });

  it('updates and removes constraints through undoable operations', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 0 }, { x: 20, y: 0 });
    const dimension = constraint('fixed_distance', [line.start.id, line.end.id], { distance: 20 });
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: dimension } });
    manager.execute({
      type: 'UPDATE_CONSTRAINT',
      payload: { constraintId: dimension.id, updates: { parameters: { distance: 30 } } },
    });
    expect(document.constraints.get(dimension.id)?.parameters?.distance).toBe(30);
    const length = () => {
      const a = document.getNode(line.start.id)!.position;
      const b = document.getNode(line.end.id)!.position;
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    expect(length()).toBeCloseTo(30, 8);
    manager.undo();
    expect(document.constraints.get(dimension.id)?.parameters?.distance).toBe(20);
    expect(length()).toBeCloseTo(20, 8);
    manager.redo();
    expect(length()).toBeCloseTo(30, 8);
    manager.execute({ type: 'REMOVE_CONSTRAINT', payload: { constraintId: dimension.id } });
    expect(document.constraints.has(dimension.id)).toBe(false);
    manager.undo();
    expect(document.constraints.has(dimension.id)).toBe(true);
  });

  it('rotates the other segment to maintain parallelism', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = addLine(document, manager, { x: 0, y: 0 }, { x: 100, y: 0 });
    const second = addLine(document, manager, { x: 0, y: 50 }, { x: 80, y: 80 });
    manager.execute({
      type: 'ADD_CONSTRAINT',
      payload: { constraint: constraint('parallel', [first.segment.id, second.segment.id]) },
    });
    manager.execute({ type: 'MOVE_NODE', payload: { nodeId: first.end.id, delta: { x: -20, y: 40 } } });
    const vector = (segment: Segment) => {
      const a = document.getNode(segment.startNodeId)!.position;
      const b = document.getNode(segment.endNodeId)!.position;
      return { x: b.x - a.x, y: b.y - a.y };
    };
    const a = vector(first.segment);
    const b = vector(second.segment);
    expect(Math.abs(a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))).toBeLessThan(1e-7);
  });

  it('reflects a symmetric partner across a fixed axis', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: -30, y: 10 }, { x: 30, y: 10 });
    manager.execute({
      type: 'ADD_CONSTRAINT',
      payload: {
        constraint: constraint('symmetric', [line.start.id, line.end.id], { axisX: 0, axisY: 0, axisAngle: 90 }),
      },
    });
    manager.execute({ type: 'MOVE_NODE', payload: { nodeId: line.start.id, delta: { x: -5, y: 12 } } });
    const left = document.getNode(line.start.id)!.position;
    const right = document.getNode(line.end.id)!.position;
    expect(right.x).toBeCloseTo(-left.x, 8);
    expect(right.y).toBeCloseTo(left.y, 8);
  });

  it('solves vertical, perpendicular, equal-length, and fixed-angle relationships', () => {
    const verticalDoc = VectorDocument.createEmpty();
    const verticalManager = new OperationManager(verticalDoc);
    const vertical = addLine(verticalDoc, verticalManager, { x: 0, y: 0 }, { x: 20, y: 100 });
    verticalManager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: constraint('vertical', [vertical.segment.id]) } });
    expect(verticalDoc.getNode(vertical.start.id)?.position.x).toBeCloseTo(verticalDoc.getNode(vertical.end.id)!.position.x, 8);

    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = addLine(document, manager, { x: 0, y: 0 }, { x: 100, y: 0 });
    const second = addLine(document, manager, { x: 0, y: 50 }, { x: 30, y: 90 });
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: constraint('perpendicular', [first.segment.id, second.segment.id]) } });
    const vector = (segment: Segment) => {
      const a = document.getNode(segment.startNodeId)!.position;
      const b = document.getNode(segment.endNodeId)!.position;
      return { x: b.x - a.x, y: b.y - a.y };
    };
    let a = vector(first.segment);
    let b = vector(second.segment);
    expect(Math.abs(a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))).toBeLessThan(1e-7);

    manager.execute({ type: 'REMOVE_CONSTRAINT', payload: { constraintId: [...document.constraints.keys()][0] } });
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: constraint('equal_length', [first.segment.id, second.segment.id]) } });
    a = vector(first.segment);
    b = vector(second.segment);
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(Math.hypot(b.x, b.y), 7);

    manager.execute({ type: 'REMOVE_CONSTRAINT', payload: { constraintId: [...document.constraints.keys()][0] } });
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: constraint('fixed_angle', [first.segment.id, second.segment.id], { angle: 60 }) } });
    a = vector(first.segment);
    b = vector(second.segment);
    const angle = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180 / Math.PI;
    expect(angle).toBeCloseTo(60, 6);
  });

  it('accepts a valid fixed angle between two segments that share a corner node', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = addLine(document, manager, { x: 0, y: 0 }, { x: 100, y: 0 });
    const networkId = document.activeNetwork.id;
    const end: VectorNode = { id: createEntityId(), position: { x: 0, y: 100 }, constraintIds: [] };
    const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
    const second: Segment = {
      id: createEntityId(),
      startNodeId: first.start.id,
      endNodeId: end.id,
      type: 'line', role: 'geometry',
    };
    manager.beginTransaction('Shared corner');
    manager.execute({ type: 'ADD_NODE', payload: { node: end, networkId } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment: second, pathId: path.id } });
    manager.commitTransaction();

    expect(() => manager.execute({
      type: 'ADD_CONSTRAINT',
      payload: {
        constraint: constraint('fixed_angle', [first.segment.id, second.id, first.start.id], { angle: 90 }),
      },
    })).not.toThrow();
    expect(document.constraints.size).toBe(1);
  });

  it('solves coincident and fixed-radius projections', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 0 }, { x: 50, y: 20 });
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: constraint('coincident', [line.start.id, line.end.id]) } });
    expect(document.getNode(line.start.id)?.position).toEqual(document.getNode(line.end.id)?.position);
    manager.undo();

    manager.beginTransaction('Native arc');
    manager.execute({ type: 'SET_NODE_POSITIONS', payload: { positions: [
      { nodeId: line.start.id, position: { x: 10, y: 0 } },
      { nodeId: line.end.id, position: { x: 0, y: 10 } },
    ] } });
    manager.execute({ type: 'SET_SEGMENT_GEOMETRIES', payload: { segments: [{
      ...line.segment,
      type: 'arc', role: 'geometry',
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
      clockwise: false,
    }] } });
    manager.commitTransaction();
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: constraint('fixed_radius', [line.segment.id], { radius: 20 }) } });
    const arc = document.getSegment(line.segment.id)!;
    const start = document.getNode(line.start.id)!.position;
    const end = document.getNode(line.end.id)!.position;
    expect(arc.radius).toBeCloseTo(20, 8);
    expect(start).toEqual({ x: 20, y: 0 });
    expect(end.x).toBeCloseTo(0, 8);
    expect(end.y).toBeCloseTo(20, 8);
  });

  it('aligns a line to a cubic tangent at their shared node', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: -60, y: 0 }, { x: 0, y: 0 });
    const networkId = document.activeNetwork.id;
    const end: VectorNode = { id: createEntityId(), position: { x: 60, y: 40 }, handleIn: { x: 30, y: 10 }, constraintIds: [] };
    const shared = document.getNode(line.end.id)!;
    manager.execute({ type: 'ADD_BEZIER_HANDLES', payload: {
      nodeId: shared.id,
      handleIn: { x: -20, y: -20 },
      handleOut: { x: 20, y: 20 },
    } });
    const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
    const curve: Segment = { id: createEntityId(), startNodeId: shared.id, endNodeId: end.id, type: 'bezier', role: 'geometry' };
    manager.beginTransaction('Curve');
    manager.execute({ type: 'ADD_NODE', payload: { node: end, networkId } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment: curve, pathId: path.id } });
    manager.commitTransaction();
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: constraint('tangent', [line.segment.id, curve.id, shared.id]) } });

    const lineStart = document.getNode(line.start.id)!.position;
    const lineEnd = document.getNode(line.end.id)!.position;
    const lineDirection = { x: lineEnd.x - lineStart.x, y: lineEnd.y - lineStart.y };
    const tangent = { x: shared.handleOut!.x - shared.position.x, y: shared.handleOut!.y - shared.position.y };
    expect(Math.abs(lineDirection.x * tangent.y - lineDirection.y * tangent.x) /
      (Math.hypot(lineDirection.x, lineDirection.y) * Math.hypot(tangent.x, tangent.y))).toBeLessThan(1e-6);
  });

  it('detects conflicting hard dimensions and rejects the operation', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 0 }, { x: 10, y: 0 });
    const first = constraint('fixed_distance', [line.start.id, line.end.id], { distance: 10 });
    const conflicting = constraint('fixed_distance', [line.start.id, line.end.id], { distance: 20 });
    const diagnostics = vi.fn();
    manager.setDiagnosticsListener(diagnostics);
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: first } });

    expect(() => manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: conflicting } }))
      .toThrow(ConstraintViolationError);
    expect(document.constraints.has(conflicting.id)).toBe(false);
    expect(diagnostics).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ constraintIds: expect.arrayContaining([first.id, conflicting.id]) }),
    ]));
  });

  it('treats medium constraints as relaxable rather than hard failures', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 0 }, { x: 10, y: 10 });
    const horizontal = constraint('horizontal', [line.segment.id]);
    const vertical = { ...constraint('vertical', [line.segment.id]), priority: 'medium' as const };
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: horizontal } });
    expect(() => manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: vertical } })).not.toThrow();
    expect(document.constraints.size).toBe(2);
  });

  it('is deterministic for identical snapshots', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addLine(document, manager, { x: 0, y: 2 }, { x: 20, y: 9 });
    document._addConstraint(constraint('horizontal', [line.segment.id]));
    const solver = new DeterministicConstraintSolver();
    const first = solver.solve(document);
    const second = solver.solve(document);
    expect([...first.adjustedNodes]).toEqual([...second.adjustedNodes]);
    expect(first.iterations).toBe(second.iterations);
  });
});
