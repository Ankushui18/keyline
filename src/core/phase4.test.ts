import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { arcTangent, evaluateSegment } from './geometry';
import { OperationManager } from './operations';
import { serializeSolverInput } from '../constraints/serialization';
import type { Segment, VectorNode, VectorPath } from './types';
import { prepareFillet, validateFillet } from '../tools/fillet-tool';
import { preparePathOffset } from '../tools/offset-tool';
import { prepareEraseSegment, prepareHealGap } from '../tools/eraser-tool';
import { prepareBulkNodePositions } from '../tools/lasso-tool';
import { prepareSplitSegment } from '../tools/cut-tool';

function addCorner(document: VectorDocument, manager: OperationManager) {
  const networkId = document.activeNetwork.id;
  const nodes: VectorNode[] = [
    { id: createEntityId(), position: { x: 0, y: 100 }, constraintIds: [] },
    { id: createEntityId(), position: { x: 100, y: 100 }, constraintIds: [] },
    { id: createEntityId(), position: { x: 100, y: 0 }, constraintIds: [] },
  ];
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
  const segments: Segment[] = [
    { id: createEntityId(), startNodeId: nodes[0].id, endNodeId: nodes[1].id, type: 'line', role: 'geometry' },
    { id: createEntityId(), startNodeId: nodes[1].id, endNodeId: nodes[2].id, type: 'line', role: 'geometry' },
  ];
  manager.beginTransaction('Corner');
  for (const node of nodes) manager.execute({ type: 'ADD_NODE', payload: { node, networkId } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  for (const segment of segments) manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { nodes, path, segments };
}

function addRectangle(document: VectorDocument, manager: OperationManager) {
  const networkId = document.activeNetwork.id;
  const nodes: VectorNode[] = [
    { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] },
    { id: createEntityId(), position: { x: 100, y: 0 }, constraintIds: [] },
    { id: createEntityId(), position: { x: 100, y: 80 }, constraintIds: [] },
    { id: createEntityId(), position: { x: 0, y: 80 }, constraintIds: [] },
  ];
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: true };
  const segments = nodes.map((node, index): Segment => ({
    id: createEntityId(),
    startNodeId: node.id,
    endNodeId: nodes[(index + 1) % nodes.length].id,
    type: 'line', role: 'geometry',
  }));
  manager.beginTransaction('Rectangle');
  for (const node of nodes) manager.execute({ type: 'ADD_NODE', payload: { node, networkId } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  for (const segment of segments) manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { nodes, path, segments };
}

describe('Phase 4 native arcs and fillets', () => {
  it('evaluates and persists native circular arc geometry', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const corner = addCorner(document, manager);
    const plan = prepareFillet(document, corner.nodes[1].id, 20)!;
    manager.beginTransaction('Fillet');
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: plan.patch });
    for (const constraint of plan.constraints) {
      manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint } });
    }
    manager.commitTransaction();

    const arc = document.getSegment(plan.arcSegmentId)!;
    expect(arc.type).toBe('arc');
    expect(arc.radius).toBeCloseTo(20, 8);
    expect(evaluateSegment(document, arc, 0)).toEqual(document.getNode(arc.startNodeId)?.position);
    expect(evaluateSegment(document, arc, 1).x).toBeCloseTo(document.getNode(arc.endNodeId)!.position.x, 8);
    expect(evaluateSegment(document, arc, 1).y).toBeCloseTo(document.getNode(arc.endNodeId)!.position.y, 8);
    expect([...document.constraints.values()].filter((item) => item.type === 'tangent')).toHaveLength(2);
    expect([...document.constraints.values()].find((item) => item.type === 'fixed_radius')?.parameters?.radius).toBeCloseTo(20, 8);

    const restored = new VectorDocument(document.toSnapshot());
    expect(restored.getSegment(arc.id)).toMatchObject({
      type: 'arc', role: 'geometry',
      radius: 20,
      center: arc.center,
      startAngle: arc.startAngle,
      endAngle: arc.endAngle,
    });
    expect(serializeSolverInput(restored).segments.find((segment) => segment.id === arc.id)).toMatchObject({
      segmentType: 'arc',
      center: arc.center,
      radius: 20,
      startAngle: arc.startAngle,
      endAngle: arc.endAngle,
    });

    manager.undo();
    expect(document.getSegment(plan.arcSegmentId)).toBeUndefined();
    expect(document.getNode(corner.nodes[1].id)?.position).toEqual({ x: 100, y: 100 });
    expect(document.getPath(corner.path.id)?.segmentIds).toEqual(corner.segments.map((segment) => segment.id));
  });

  it('pre-validates unsupported fillet radii without mutating graph topology', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const corner = addCorner(document, manager);
    const before = {
      nodes: document.nodes.size,
      segments: document.segments.size,
      constraints: document.constraints.size,
    };
    const validation = validateFillet(document, corner.nodes[1].id, 500);
    expect(validation).toMatchObject({ valid: false });
    if (!validation.valid) expect(validation.message).toMatch(/Radius is too large for this corner/);
    expect(prepareFillet(document, corner.nodes[1].id, 500)).toBeNull();
    expect({
      nodes: document.nodes.size,
      segments: document.segments.size,
      constraints: document.constraints.size,
    }).toEqual(before);
  });

  it('detects a stable region bounded entirely by native arcs', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const networkId = document.activeNetwork.id;
    const left: VectorNode = { id: createEntityId(), position: { x: -50, y: 0 }, constraintIds: [] };
    const right: VectorNode = { id: createEntityId(), position: { x: 50, y: 0 }, constraintIds: [] };
    const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: true };
    const upper: Segment = {
      id: createEntityId(), startNodeId: left.id, endNodeId: right.id, type: 'arc', role: 'geometry',
      center: { x: 0, y: 0 }, radius: 50, startAngle: Math.PI, endAngle: 0, clockwise: false,
    };
    const lower: Segment = {
      id: createEntityId(), startNodeId: right.id, endNodeId: left.id, type: 'arc', role: 'geometry',
      center: { x: 0, y: 0 }, radius: 50, startAngle: 0, endAngle: Math.PI, clockwise: false,
    };
    manager.beginTransaction('Arc circle');
    manager.execute({ type: 'ADD_NODE', payload: { node: left, networkId } });
    manager.execute({ type: 'ADD_NODE', payload: { node: right, networkId } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment: upper, pathId: path.id } });
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment: lower, pathId: path.id } });
    manager.commitTransaction();
    expect(document.regions).toHaveLength(1);
    const regionId = document.regions[0].id;
    manager.beginTransaction('Resize arc circle');
    manager.execute({ type: 'SET_NODE_POSITIONS', payload: { positions: [
      { nodeId: left.id, position: { x: -60, y: 0 } },
      { nodeId: right.id, position: { x: 60, y: 0 } },
    ] } });
    manager.execute({ type: 'SET_SEGMENT_GEOMETRIES', payload: { segments: [
      { ...upper, radius: 60 },
      { ...lower, radius: 60 },
    ] } });
    manager.commitTransaction();
    expect(document.regions[0].id).toBe(regionId);
  });

  it('splits native arcs without converting them to Bézier or line geometry', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const corner = addCorner(document, manager);
    const fillet = prepareFillet(document, corner.nodes[1].id, 20)!;
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: fillet.patch });
    const original = document.getSegment(fillet.arcSegmentId)!;
    const split = prepareSplitSegment(document, original.id, 0.4)!;
    manager.execute({ type: 'SPLIT_SEGMENT', payload: split });
    const first = document.getSegment(split.newSegment1Id)!;
    const second = document.getSegment(split.newSegment2Id)!;
    expect(first).toMatchObject({ type: 'arc', role: 'geometry', center: original.center, radius: original.radius, clockwise: original.clockwise });
    expect(second).toMatchObject({ type: 'arc', role: 'geometry', center: original.center, radius: original.radius, clockwise: original.clockwise });
    expect(first.endAngle).toBeCloseTo(second.startAngle!, 10);
    expect(document.getNode(split.newNodeId)?.position).toEqual(split.splitPoint);
    manager.undo();
    expect(document.getSegment(original.id)).toMatchObject({ type: 'arc', role: 'geometry', radius: 20 });
  });

  it('solves a fixed radius against native arc radius instead of chord length', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const corner = addCorner(document, manager);
    const plan = prepareFillet(document, corner.nodes[1].id, 12)!;
    manager.beginTransaction('Fillet');
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: plan.patch });
    for (const constraint of plan.constraints) manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint } });
    manager.commitTransaction();

    const radiusConstraint = plan.constraints.find((item) => item.type === 'fixed_radius')!;
    manager.execute({
      type: 'UPDATE_CONSTRAINT',
      payload: { constraintId: radiusConstraint.id, updates: { parameters: { radius: 18 } } },
    });
    const arc = document.getSegment(plan.arcSegmentId)!;
    expect(arc.radius).toBeCloseTo(18, 8);
    const chord = Math.hypot(
      document.getNode(arc.endNodeId)!.position.x - document.getNode(arc.startNodeId)!.position.x,
      document.getNode(arc.endNodeId)!.position.y - document.getNode(arc.startNodeId)!.position.y,
    );
    expect(chord).toBeCloseTo(18 * Math.sqrt(2), 6);
    expect(chord).not.toBeCloseTo(36, 4);
    const normalizedCross = (segment: Segment, tangent: { x: number; y: number }) => {
      const start = document.getNode(segment.startNodeId)!.position;
      const end = document.getNode(segment.endNodeId)!.position;
      const vector = { x: end.x - start.x, y: end.y - start.y };
      return Math.abs(vector.x * tangent.y - vector.y * tangent.x) /
        (Math.hypot(vector.x, vector.y) * Math.hypot(tangent.x, tangent.y));
    };
    expect(normalizedCross(document.getSegment(corner.segments[0].id)!, arcTangent(arc, 0))).toBeLessThan(1e-7);
    expect(normalizedCross(document.getSegment(corner.segments[1].id)!, arcTangent(arc, 1))).toBeLessThan(1e-7);
  });

  it('keeps a live fill bound to the stable region ID after boundary reshaping', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const rectangle = addRectangle(document, manager);
    const region = document.regions[0];
    expect(region).toBeDefined();
    manager.execute({
      type: 'SET_REGION_FILL',
      payload: { regionId: region.id, fill: { type: 'solid', color: '#ff5577' } },
    });
    manager.execute({
      type: 'MOVE_NODE',
      payload: { nodeId: rectangle.nodes[1].id, delta: { x: 25, y: 10 } },
    });
    expect(document.regions[0].id).toBe(region.id);
    expect(document.regions[0].fill).toEqual({ type: 'solid', color: '#ff5577' });
    manager.undo();
    expect(document.regions[0].fill).toEqual({ type: 'solid', color: '#ff5577' });
    manager.undo();
    expect(document.regions[0].fill).toBeUndefined();
  });

  it('creates typed path offsets transactionally', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const source = addCorner(document, manager);
    const offset = preparePathOffset(document, source.path.id, 10)!;
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: offset.patch });
    expect(document.getPath(offset.resultPathId)?.segmentIds).toEqual(offset.resultSegmentIds);
    expect(offset.resultSegmentIds.map((id) => document.getSegment(id)?.type)).toEqual(['line', 'line']);
    expect(document.paths.size).toBe(2);
    manager.undo();
    expect(document.getPath(offset.resultPathId)).toBeUndefined();
    expect(document.getPath(source.path.id)?.segmentIds).toEqual(source.segments.map((segment) => segment.id));
  });

  it('persists live parametric groups without cloning source topology', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const source = addCorner(document, manager);
    const nodeCount = document.nodes.size;
    const segmentCount = document.segments.size;
    const group = {
      id: createEntityId(),
      sourcePathIds: [source.path.id],
      transform: { type: 'mirror' as const, axis: 'y' as const, origin: { x: 50, y: 50 } },
    };
    manager.execute({ type: 'ADD_PARAMETRIC_GROUP', payload: { group } });
    manager.execute({ type: 'MOVE_NODE', payload: { nodeId: source.nodes[0].id, delta: { x: 7, y: -3 } } });
    expect(document.nodes.size).toBe(nodeCount);
    expect(document.segments.size).toBe(segmentCount);
    expect(document.parametricGroups.get(group.id)?.sourcePathIds).toEqual([source.path.id]);
    expect(new VectorDocument(document.toSnapshot()).parametricGroups.get(group.id)).toEqual(group);
    manager.undo();
    expect(document.parametricGroups.has(group.id)).toBe(true);
    manager.undo();
    expect(document.parametricGroups.has(group.id)).toBe(false);
  });

  it('applies lasso bulk alignment, distribution, and symmetry atomically', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const source = addCorner(document, manager);
    const ids = source.nodes.map((node) => node.id);
    const horizontal = prepareBulkNodePositions(document, ids, 'horizontal');
    manager.execute({ type: 'SET_NODE_POSITIONS', payload: { positions: horizontal } });
    expect(new Set(ids.map((id) => document.getNode(id)!.position.y)).size).toBe(1);
    manager.undo();

    const distributed = prepareBulkNodePositions(document, ids, 'distribute');
    manager.execute({ type: 'SET_NODE_POSITIONS', payload: { positions: distributed } });
    const sortedX = ids.map((id) => document.getNode(id)!.position.x).sort((a, b) => a - b);
    expect(sortedX[1] - sortedX[0]).toBeCloseTo(sortedX[2] - sortedX[1], 8);
    manager.undo();

    const symmetric = prepareBulkNodePositions(document, ids, 'symmetry');
    manager.execute({ type: 'SET_NODE_POSITIONS', payload: { positions: symmetric } });
    const points = ids.map((id) => document.getNode(id)!.position).sort((a, b) => a.x - b.x);
    expect(points[0].y).toBeCloseTo(points[2].y, 8);
    expect(points[1].x).toBeCloseTo((points[0].x + points[2].x) / 2, 8);
  });

  it('erases constrained geometry and heals the gap transactionally', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const source = addCorner(document, manager);
    const horizontal = {
      id: createEntityId(),
      type: 'horizontal' as const,
      priority: 'hard' as const,
      targetIds: [source.segments[0].id],
      tolerance: 1e-6,
    };
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: horizontal } });
    const erase = prepareEraseSegment(document, source.segments[0].id)!;
    manager.beginTransaction('Erase');
    for (const constraintId of erase.removedConstraintIds) {
      manager.execute({ type: 'REMOVE_CONSTRAINT', payload: { constraintId } });
    }
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: erase.patch });
    manager.commitTransaction();
    expect(document.getSegment(source.segments[0].id)).toBeUndefined();
    expect(document.constraints.has(horizontal.id)).toBe(false);

    const heal = prepareHealGap(document, erase.gapNodeIds[0], erase.gapNodeIds[1], 'arc')!;
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: heal.patch });
    expect(document.getSegment(heal.segment.id)).toMatchObject({ type: 'arc', role: 'geometry' });
    expect(document.getPath(source.path.id)?.segmentIds).toEqual([heal.segment.id, source.segments[1].id]);
    manager.undo();
    expect(document.getSegment(heal.segment.id)).toBeUndefined();
    manager.undo();
    expect(document.getSegment(source.segments[0].id)).toBeDefined();
    expect(document.constraints.has(horizontal.id)).toBe(true);
  });

  it('persists width profiles without changing solver topology', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = addCorner(document, manager).segments[0];
    const nodeCount = document.nodes.size;
    const segmentCount = document.segments.size;
    manager.execute({
      type: 'ADD_CONSTRAINT',
      payload: { constraint: {
        id: createEntityId(), type: 'horizontal', priority: 'hard',
        targetIds: [line.id], tolerance: 1e-6,
      } },
    });
    const positionsBefore = [...document.nodes].map(([id, node]) => [id, { ...node.position }] as const);
    const profile = [
      { id: createEntityId(), t: 0.25, width: 8 },
      { id: createEntityId(), t: 0.7, width: 18 },
    ];
    manager.execute({
      type: 'SET_SEGMENT_WIDTH_PROFILE',
      payload: { segmentId: line.id, widthProfile: profile },
    });
    expect(document.nodes.size).toBe(nodeCount);
    expect(document.segments.size).toBe(segmentCount);
    expect([...document.nodes].map(([id, node]) => [id, node.position])).toEqual(positionsBefore);
    expect(new VectorDocument(document.toSnapshot()).getSegment(line.id)?.widthProfile).toEqual(profile);
    manager.undo();
    expect(document.getSegment(line.id)?.widthProfile).toBeUndefined();
  });
});
