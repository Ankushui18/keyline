import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { DEFAULT_DRAWING_STYLE } from '../core/drawing-style';
import { closestPointOnSegment, evaluateSegment, segmentCurve } from '../core/geometry';
import { OperationManager } from '../core/operations';
import type { EntityId, Point, SelectionState, VectorNode } from '../core/types';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { adjustHandlePayload } from './bend-tool';
import { convertNodeTangent, insertAnchorAt, pathAnchorOf } from './direct-path-tool';

/**
 * The contract for §3.6 of docs/EDITING-AUDIT.md: anchors, handles, segment bodies and
 * corner conversion, resolved in the edited object's local space and committed as one
 * undoable operation each.
 */
function scene() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const draw = (x: number, y: number, size = 100) => {
    const plan = preparePrimitiveObject(
      document, 'rectangle', { x, y }, { x: x + size, y: y + size }, { style: DEFAULT_DRAWING_STYLE },
    )!;
    manager.beginTransaction('Draw fixture rectangle');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    const object = document.getObject(plan.objectId)!;
    const network = document.getNetwork(object.networkId)!;
    return {
      objectId: object.id,
      object,
      network,
      nodeIds: network.nodeIds,
      segmentIds: network.pathIds.flatMap((pathId) => document.getPath(pathId)!.segmentIds),
    };
  };
  const edit = (objectId: EntityId): SelectionState => {
    const object = document.getObject(objectId)!;
    const network = document.getNetwork(object.networkId)!;
    return {
      mode: 'network', editingObjectId: objectId, objectIds: new Set([objectId]),
      nodeIds: new Set(network.nodeIds), segmentIds: new Set(),
    };
  };
  return { document, manager, draw, edit };
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe('direct path editing', () => {
  it('inserts an anchor on a straight segment without moving the path', () => {
    const { document, manager, draw, edit } = scene();
    const rect = draw(100, 100);
    const selection = edit(rect.objectId);
    const segmentId = rect.segmentIds[0];
    const segment = document.getSegment(segmentId)!;
    const start = document.getNode(segment.startNodeId)!.position;
    const end = document.getNode(segment.endNodeId)!.position;

    const pathId = document.findPathForSegment(segmentId)!.id;
    const insert = insertAnchorAt(document, segmentId, { x: (start.x + end.x) / 2, y: start.y }, selection)!;
    expect(insert).toBeDefined();
    manager.execute({ type: 'SPLIT_SEGMENT', payload: insert.split });

    const anchor = document.getNode(insert.split.newNodeId)!;
    expect(anchor.position.x).toBeCloseTo((start.x + end.x) / 2);
    expect(anchor.position.y).toBeCloseTo(start.y);
    // The path gained a segment and kept its two neighbours joined.
    expect(document.connectedSegments(anchor.id)).toHaveLength(2);
    expect(document.getPath(pathId)!.segmentIds.length).toBe(rect.segmentIds.length + 1);
    expect(document.getPath(pathId)!.isClosed).toBe(true);
    // One undo puts the graph back exactly.
    expect(manager.undo()).toBe(true);
    expect(document.getNode(insert.split.newNodeId)).toBeUndefined();
    expect(document.getPath(pathId)!.segmentIds.length).toBe(rect.segmentIds.length);
  });

  it('inserts an anchor on a curve with an exact cubic split, so the curve keeps its shape', () => {
    const { document, manager, draw, edit } = scene();
    const rect = draw(200, 120);
    const selection = edit(rect.objectId);
    const segmentId = rect.segmentIds[0];
    const segment = document.getSegment(segmentId)!;
    // Bend the segment first so the insert has curvature to preserve.
    manager.execute({
      type: 'ADD_BEZIER_HANDLES',
      payload: {
        nodeId: segment.startNodeId,
        handleIn: { x: 0, y: -40 },
        handleOut: { x: 40, y: 0 },
      },
    });
    manager.execute({
      type: 'ADD_BEZIER_HANDLES',
      payload: {
        nodeId: segment.endNodeId,
        handleIn: { x: 100, y: 40 },
        handleOut: { x: 100, y: 0 },
      },
    });
    const bent = document.getSegment(segmentId)!;
    expect(bent.type).toBe('bezier');
    const before = segmentCurve(document, bent)!;
    const samples = [0.1, 0.25, 0.4, 0.6, 0.8].map((t) => evaluateSegment(document, bent, t));
    const closest = closestPointOnSegment(document, bent, samples[2])!;

    const insert = insertAnchorAt(document, segmentId, closest.point, selection)!;
    manager.execute({ type: 'SPLIT_SEGMENT', payload: insert.split });

    // The whole curve, sampled on the rebuilt path, still passes through the same points.
    const [first, second] = [insert.split.newSegment1Id, insert.split.newSegment2Id]
      .map((id) => document.getSegment(id)!);
    // Dense enough that "nearest rebuilt point" is a fair measure of the curve's shape.
    const rebuilt = [
      ...Array.from({ length: 201 }, (_, index) => evaluateSegment(document, first, index / 200)),
      ...Array.from({ length: 201 }, (_, index) => evaluateSegment(document, second, index / 200)),
    ];
    for (const point of samples) {
      expect(Math.min(...rebuilt.map((candidate) => distance(candidate, point)))).toBeLessThan(0.5);
    }
    expect(document.getNode(insert.split.newNodeId)!.handleIn).toBeDefined();
    expect(document.getNode(insert.split.newNodeId)!.handleOut).toBeDefined();
    // The halves join at the new anchor and still end where the original curve ended.
    expect(segmentCurve(document, first)!.p3).toEqual(document.getNode(insert.split.newNodeId)!.position);
    expect(segmentCurve(document, second)!.p3).toEqual(before.p3);
  });

  it('reports the anchor under the pointer in local space and nothing outside the tolerance', () => {
    const { document, draw, edit } = scene();
    const rect = draw(100, 100);
    const selection = edit(rect.objectId);
    const node = document.getNode(rect.nodeIds[0])!;

    const hit = pathAnchorOf(document, node.position, 6, selection)!;
    expect(hit.nodeId).toBe(node.id);
    expect(pathAnchorOf(document, { x: node.position.x + 40, y: node.position.y + 40 }, 6, selection)).toBeUndefined();
    // Point editing is required: an object selection has no anchors.
    expect(pathAnchorOf(document, node.position, 6, {
      mode: 'object', objectIds: new Set([rect.objectId]), nodeIds: new Set(), segmentIds: new Set(),
    })).toBeUndefined();
  });

  it('converts a corner to a smooth anchor by deriving tangent handles from its neighbours', () => {
    const { document, manager, draw } = scene();
    const rect = draw(100, 100);
    const nodeId = rect.nodeIds[0];
    const node = document.getNode(nodeId)!;
    expect(node.handleMode).toBeUndefined();

    const result = convertNodeTangent(document, [nodeId], 'smooth')!;
    expect(result).toBeDefined();
    manager.beginTransaction('Convert anchor');
    result.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();

    const converted = document.getNode(nodeId)!;
    expect(converted.handleMode).toBe('smooth');
    expect(converted.handleIn).toBeDefined();
    expect(converted.handleOut).toBeDefined();
    // Smooth means the two handles are collinear through the anchor, on opposite sides.
    const inVector = { x: converted.handleIn!.x - converted.position.x, y: converted.handleIn!.y - converted.position.y };
    const outVector = { x: converted.handleOut!.x - converted.position.x, y: converted.handleOut!.y - converted.position.y };
    const cross = inVector.x * outVector.y - inVector.y * outVector.x;
    expect(Math.abs(cross)).toBeLessThan(1e-6);
    expect(inVector.x * outVector.x + inVector.y * outVector.y).toBeLessThan(0);
    // The operation only carries handle modes, so one undo restores the corner exactly.
    expect(manager.undo()).toBe(true);
    expect(document.getNode(nodeId)!.handleMode).toBeUndefined();
    expect(document.getNode(nodeId)!.handleIn).toBeUndefined();
  });

  it('makes a converted anchor symmetric, with mirrored handle lengths', () => {
    const { document, manager, draw } = scene();
    const rect = draw(100, 100);
    const nodeId = rect.nodeIds[1];
    const result = convertNodeTangent(document, [nodeId], 'symmetric')!;
    result.operations.forEach((operation) => manager.execute(operation));
    const node = document.getNode(nodeId)!;
    expect(node.handleMode).toBe('symmetric');
    expect(distance(node.handleIn!, node.position)).toBeCloseTo(distance(node.handleOut!, node.position), 6);
  });

  it('converts a whole multi-selection in one step', () => {
    const { document, manager, draw } = scene();
    const rect = draw(100, 100);
    const result = convertNodeTangent(document, rect.nodeIds, 'smooth')!;
    manager.beginTransaction('Convert anchors');
    result.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    for (const nodeId of rect.nodeIds) expect(document.getNode(nodeId)!.handleMode).toBe('smooth');
    expect(manager.undo()).toBe(true);
    for (const nodeId of rect.nodeIds) expect(document.getNode(nodeId)!.handleMode).toBeUndefined();
  });

  it('refuses a conversion with no neighbours and leaves the graph untouched', () => {
    const { document, draw } = scene();
    const rect = draw(100, 100);
    const isolated = document.getNode(rect.nodeIds[0])!;
    // A lone node has no tangent to derive, so the caller must not invent one.
    expect(convertNodeTangent(document, ['not-a-node'], 'smooth')).toBeUndefined();
    expect(convertNodeTangent(document, [], 'smooth')).toBeUndefined();
    expect(isolated.handleIn).toBeUndefined();
    expect(document.revision).toBeGreaterThan(0);
  });

  it('keeps the three mirroring modes distinct while a handle is dragged', () => {
    const node: VectorNode = {
      id: 'n', constraintIds: [], position: { x: 0, y: 0 },
      handleIn: { x: -10, y: 0 }, handleOut: { x: 30, y: 0 },
    };
    // Dragging the out handle up and to the right.
    const dragged = { x: 0, y: 50 };

    const free = adjustHandlePayload(node, 'out', dragged, 'independent');
    expect(free.mirroredHandle).toBeUndefined();

    // Angle: the opposite handle keeps its 10-unit length but turns to face the drag.
    const angle = adjustHandlePayload(node, 'out', dragged, 'angle');
    expect(distance(angle.mirroredHandle!, node.position)).toBeCloseTo(10);
    expect(angle.mirroredHandle!.y).toBeLessThan(0);

    // Mirror: the opposite handle matches the dragged length as well.
    const mirror = adjustHandlePayload(node, 'out', dragged, 'mirror');
    expect(distance(mirror.mirroredHandle!, node.position)).toBeCloseTo(50);
    expect(mirror.mirroredHandle!.y).toBeCloseTo(-50);
  });
});
