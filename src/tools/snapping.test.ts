import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Segment, VectorNode, VectorPath } from '../core/types';
import { preparePrimitiveObject } from './primitive-tool';
import { snapPoint } from './snapping';

function addLine(
  document: VectorDocument,
  manager: OperationManager,
  start: { x: number; y: number },
  end: { x: number; y: number },
  role: Segment['role'] = 'geometry',
  constructionExtent: Segment['constructionExtent'] = role === 'construction' ? 'finite' : undefined,
) {
  const nodes: VectorNode[] = [start, end].map((position) => ({ id: createEntityId(), position, constraintIds: [] }));
  const segment: Segment = {
    id: createEntityId(), startNodeId: nodes[0].id, endNodeId: nodes[1].id,
    type: 'line', role, constructionExtent,
  };
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
  manager.beginTransaction('Line fixture');
  nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId: document.activeNetwork.id } }));
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { nodes, segment };
}

describe('shared snapping service', () => {
  it('prioritizes transformed nodes and segment midpoints within a screen-space tolerance', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { nodes } = addLine(document, manager, { x: 0, y: 0 }, { x: 20, y: 0 });
    const object = document.getObjectForNode(nodes[0].id)!;
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: object.id, updates: { transform: { ...object.transform, x: 100, y: 50 } } },
    });
    const node = snapPoint(document, { x: 101, y: 49 }, { scale: 1, grid: false, intersections: false });
    expect(node.point).toEqual({ x: 100, y: 50 });
    expect(node.matches[0]).toMatchObject({ kind: 'node', targetId: nodes[0].id });
    const midpoint = snapPoint(document, { x: 110, y: 53 }, { scale: 1, tolerancePixels: 4, nodes: false, grid: false, intersections: false });
    expect(midpoint.point).toEqual({ x: 110, y: 50 });
    expect(midpoint.matches[0].kind).toBe('midpoint');
  });

  it('snaps to finite line intersections and grid points without changing topology', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addLine(document, manager, { x: 0, y: 0 }, { x: 20, y: 20 });
    addLine(document, manager, { x: 0, y: 20 }, { x: 20, y: 0 });
    const before = document.toSnapshot();
    const intersection = snapPoint(document, { x: 11, y: 9 }, { scale: 1, grid: false });
    expect(intersection.point).toEqual({ x: 10, y: 10 });
    expect(intersection.matches[0].kind).toBe('intersection');
    const grid = snapPoint(document, { x: 28, y: 32 }, {
      scale: 1, tolerancePixels: 5, nodes: false, midpoints: false, intersections: false, alignment: false, gridSize: 10,
    });
    expect(grid.point).toEqual({ x: 30, y: 30 });
    expect(document.toSnapshot()).toEqual(before);
  });

  it('supports independent alignment guides when no point candidate wins', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addLine(document, manager, { x: 40, y: 10 }, { x: 80, y: 70 });
    const result = snapPoint(document, { x: 43, y: 68 }, {
      scale: 1, tolerancePixels: 4, grid: false, midpoints: false, intersections: false,
    });
    expect(result.point).toEqual({ x: 40, y: 70 });
    expect(result.guideX).toBe(40);
    expect(result.guideY).toBe(70);
  });

  it('projects directly to finite and unbounded construction domains with the target segment ID', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { segment } = addLine(document, manager, { x: 0, y: 0 }, { x: 10, y: 0 }, 'construction', 'finite');
    const options = {
      scale: 1, tolerancePixels: 2, nodes: false, midpoints: false,
      intersections: false, grid: false, alignment: false,
    };
    const finite = snapPoint(document, { x: 20, y: 1 }, options);
    expect(finite.point).toEqual({ x: 20, y: 1 });
    expect(finite.matches).toEqual([]);

    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: [{ segmentId: segment.id, role: 'construction', constructionExtent: 'infinite' }] },
    });
    const infinite = snapPoint(document, { x: 20, y: 1 }, options);
    expect(infinite.point).toEqual({ x: 20, y: 0 });
    expect(infinite.matches[0]).toMatchObject({ kind: 'construction-line', targetId: segment.id });
  });

  it('enforces node > intersection > construction projection > midpoint priority within tolerance', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const construction = addLine(document, manager, { x: 0, y: 0 }, { x: 10, y: 0 }, 'construction', 'infinite');
    const nodeLine = addLine(document, manager, { x: 5, y: 1 }, { x: 15, y: 1 });
    const node = snapPoint(document, { x: 5, y: 0.1 }, {
      scale: 1, tolerancePixels: 2, intersections: false, midpoints: false, grid: false, alignment: false,
    });
    expect(node.matches[0]).toMatchObject({ kind: 'node', targetId: nodeLine.nodes[0].id });

    const crossing = addLine(document, manager, { x: 7, y: -5 }, { x: 7, y: 5 });
    const intersection = snapPoint(document, { x: 7, y: 0.8 }, {
      scale: 1, tolerancePixels: 2, nodes: false, midpoints: false, grid: false, alignment: false,
      excludeSegmentIds: new Set([nodeLine.segment.id]),
    });
    expect(intersection.matches[0]).toMatchObject({ kind: 'intersection', targetId: construction.segment.id });
    expect(intersection.point).toEqual({ x: 7, y: 0 });

    const projection = snapPoint(document, { x: 5, y: 0.8 }, {
      scale: 1, tolerancePixels: 2, nodes: false, intersections: false, grid: false, alignment: false,
    });
    expect(projection.matches[0]).toMatchObject({ kind: 'construction-line', targetId: construction.segment.id });
    expect(projection.matches[0].kind).not.toBe('midpoint');
    expect(crossing.segment.id).toBeTruthy();
  });

  it('enforces finite and infinite parameters for geometry/construction and construction/construction intersections', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const horizontal = addLine(document, manager, { x: 0, y: 0 }, { x: 10, y: 0 }, 'construction', 'infinite');
    addLine(document, manager, { x: 20, y: -5 }, { x: 20, y: 5 });
    const options = {
      scale: 1, tolerancePixels: 2, nodes: false, constructionLines: false,
      midpoints: false, grid: false, alignment: false,
    };
    expect(snapPoint(document, { x: 20, y: 0.5 }, options).matches[0]?.kind).toBe('intersection');

    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: [{ segmentId: horizontal.segment.id, role: 'construction', constructionExtent: 'finite' }] },
    });
    expect(snapPoint(document, { x: 20, y: 0.5 }, options).matches).toEqual([]);

    addLine(document, manager, { x: 5, y: -5 }, { x: 5, y: 5 }, 'construction', 'finite');
    const finiteIntersection = snapPoint(document, { x: 5.5, y: 0.5 }, options);
    expect(finiteIntersection.point.x).toBeCloseTo(5);
    expect(finiteIntersection.point.y).toBeCloseTo(0);
    expect(finiteIntersection.matches[0]?.kind).toBe('intersection');

    const outsideGeometry = VectorDocument.createEmpty();
    const outsideManager = new OperationManager(outsideGeometry);
    addLine(outsideGeometry, outsideManager, { x: 0, y: 0 }, { x: 10, y: 0 }, 'construction', 'infinite');
    addLine(outsideGeometry, outsideManager, { x: 20, y: 10 }, { x: 20, y: 20 });
    expect(snapPoint(outsideGeometry, { x: 20, y: 0 }, options).matches).toEqual([]);
  });

  it('intersects construction with deterministically flattened Béziers and native arcs', () => {
    const bezierDocument = VectorDocument.createEmpty();
    const bezierManager = new OperationManager(bezierDocument);
    const construction = addLine(bezierDocument, bezierManager, { x: -20, y: 0 }, { x: 20, y: 0 }, 'construction', 'infinite');
    const bezierNodes: VectorNode[] = [
      { id: createEntityId(), position: { x: 0, y: -10 }, handleOut: { x: 5, y: -10 }, constraintIds: [] },
      { id: createEntityId(), position: { x: 20, y: 10 }, handleIn: { x: 15, y: 10 }, constraintIds: [] },
    ];
    const bezier: Segment = {
      id: createEntityId(), startNodeId: bezierNodes[0].id, endNodeId: bezierNodes[1].id,
      type: 'bezier', role: 'geometry',
    };
    const bezierPath: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
    bezierManager.beginTransaction('Bézier intersection fixture');
    bezierNodes.forEach((node) => bezierManager.execute({ type: 'ADD_NODE', payload: { node, networkId: bezierDocument.activeNetwork.id } }));
    bezierManager.execute({ type: 'ADD_PATH', payload: { path: bezierPath, networkId: bezierDocument.activeNetwork.id } });
    bezierManager.execute({ type: 'ADD_SEGMENT', payload: { segment: bezier, pathId: bezierPath.id } });
    bezierManager.commitTransaction();
    const bezierHit = snapPoint(bezierDocument, { x: 10.6, y: 0.4 }, {
      scale: 1, tolerancePixels: 2, nodes: false, constructionLines: false,
      midpoints: false, grid: false, alignment: false,
    });
    expect(bezierHit.matches[0]).toMatchObject({ kind: 'intersection', targetId: construction.segment.id });
    expect(bezierHit.point.x).toBeCloseTo(10, 1);
    expect(bezierHit.point.y).toBeCloseTo(0, 6);

    const arcDocument = VectorDocument.createEmpty();
    const arcManager = new OperationManager(arcDocument);
    const axis = addLine(arcDocument, arcManager, { x: 0, y: -20 }, { x: 0, y: 20 }, 'construction', 'infinite');
    const arcNodes: VectorNode[] = [
      { id: createEntityId(), position: { x: 10, y: 0 }, constraintIds: [] },
      { id: createEntityId(), position: { x: -10, y: 0 }, constraintIds: [] },
    ];
    const arc: Segment = {
      id: createEntityId(), startNodeId: arcNodes[0].id, endNodeId: arcNodes[1].id,
      type: 'arc', role: 'geometry', center: { x: 0, y: 0 }, radius: 10,
      startAngle: 0, endAngle: Math.PI, clockwise: false,
    };
    const arcPath: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
    arcManager.beginTransaction('Arc intersection fixture');
    arcNodes.forEach((node) => arcManager.execute({ type: 'ADD_NODE', payload: { node, networkId: arcDocument.activeNetwork.id } }));
    arcManager.execute({ type: 'ADD_PATH', payload: { path: arcPath, networkId: arcDocument.activeNetwork.id } });
    arcManager.execute({ type: 'ADD_SEGMENT', payload: { segment: arc, pathId: arcPath.id } });
    arcManager.commitTransaction();
    const arcHit = snapPoint(arcDocument, { x: 0.4, y: 9.4 }, {
      scale: 1, tolerancePixels: 2, nodes: false, constructionLines: false,
      midpoints: false, grid: false, alignment: false,
    });
    expect(arcHit.matches[0]).toMatchObject({ kind: 'intersection', targetId: axis.segment.id });
    expect(arcHit.point.x).toBeCloseTo(0, 6);
    expect(arcHit.point.y).toBeCloseTo(10, 4);
  });

  it('computes intersections in document space across separately transformed object networks', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const constructionPlan = preparePrimitiveObject(document, 'line', { x: 100, y: 50 }, { x: 120, y: 50 })!;
    const geometryPlan = preparePrimitiveObject(document, 'line', { x: 110, y: 40 }, { x: 110, y: 60 })!;
    manager.beginTransaction('Separate transformed networks');
    for (const operation of [...constructionPlan.operations, ...geometryPlan.operations]) manager.execute(operation);
    manager.commitTransaction();
    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: [{
        segmentId: constructionPlan.segmentIds[0], role: 'construction', constructionExtent: 'infinite',
      }] },
    });
    const options = {
      scale: 1, tolerancePixels: 2, nodes: false, constructionLines: false,
      midpoints: false, grid: false, alignment: false,
    };
    const documentHit = snapPoint(document, { x: 110.8, y: 49.4 }, options);
    expect(documentHit.point.x).toBeCloseTo(110);
    expect(documentHit.point.y).toBeCloseTo(50);
    expect(documentHit.matches[0]).toMatchObject({ kind: 'intersection', targetId: constructionPlan.segmentIds[0] });
    expect(snapPoint(document, { x: 0, y: 0 }, options).matches).toEqual([]);
  });

  it('excludes the owning construction segment from projection and intersections while retaining other guides', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const owner = addLine(document, manager, { x: 0, y: 0 }, { x: 10, y: 0 }, 'construction', 'infinite');
    const other = addLine(document, manager, { x: 0, y: 2 }, { x: 10, y: 2 }, 'construction', 'infinite');
    const vertical = addLine(document, manager, { x: 20, y: -5 }, { x: 20, y: 5 }, 'construction', 'finite');
    const baseOptions = {
      scale: 1, tolerancePixels: 1, nodes: false, midpoints: false, grid: false, alignment: false,
    };
    const intersection = snapPoint(document, { x: 20, y: 0.2 }, baseOptions);
    expect(intersection.matches[0]).toMatchObject({ kind: 'intersection', targetId: owner.segment.id });

    const excluded = snapPoint(document, { x: 20, y: 0.2 }, {
      ...baseOptions,
      excludeSegmentIds: new Set([owner.segment.id]),
    });
    expect(excluded.matches[0]).toMatchObject({ kind: 'construction-line', targetId: vertical.segment.id });

    const otherProjection = snapPoint(document, { x: 30, y: 1.2 }, {
      ...baseOptions,
      tolerancePixels: 2,
      intersections: false,
      excludeSegmentIds: new Set([owner.segment.id]),
    });
    expect(otherProjection.matches[0]).toMatchObject({ kind: 'construction-line', targetId: other.segment.id });
  });
});
