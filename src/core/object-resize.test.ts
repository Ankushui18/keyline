import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { INTERACTION_BOUNDS_POLICY, objectBounds, type GeometryBounds } from './object-geometry';
import { prepareResizeObjects, resizeHandlePoints, resizeTargets, selectionFrame } from './object-resize';
import { OperationManager } from './operations';
import type { OperationInput } from './operations';
import type { EntityId, NetworkObject, Segment, VectorNode, VectorPath } from './types';

function addRectangle(
  document: VectorDocument,
  manager: OperationManager,
  width = 100,
  height = 50,
): NetworkObject {
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  const nodes = corners.map((position): VectorNode => ({ id: createEntityId(), position, constraintIds: [] }));
  const segments = nodes.map((node, index): Segment => ({
    id: createEntityId(),
    startNodeId: node.id,
    endNodeId: nodes[(index + 1) % nodes.length].id,
    type: 'line',
    role: 'geometry',
  }));
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: true };
  manager.beginTransaction('Fixture rectangle');
  for (const node of nodes) manager.execute({ type: 'ADD_NODE', payload: { node, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId: document.activeNetwork.id } });
  for (const segment of segments) manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return document.getObjectForSegment(segments[0].id)!;
}

function apply(manager: OperationManager, operations: OperationInput[]): void {
  manager.beginTransaction('Resize objects');
  for (const operation of operations) manager.execute(operation);
  manager.commitTransaction();
}

function boundsOf(document: VectorDocument, objectId: EntityId): GeometryBounds {
  return objectBounds(document, objectId, INTERACTION_BOUNDS_POLICY);
}

function setup(rotation = 0) {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const object = addRectangle(document, manager);
  if (rotation !== 0) {
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: object.id, updates: { transform: { ...object.transform, rotation } } },
    });
  }
  const targets = resizeTargets(document, [object.id]);
  const frame = selectionFrame(document, [object.id])!;
  return { document, manager, object: document.getObject(object.id)!, targets, frame };
}

describe('object resize', () => {
  it('places eight handles on the selection frame in world space', () => {
    const frame: GeometryBounds = { minX: 0, minY: 0, maxX: 100, maxY: 50, width: 100, height: 50 };
    expect(resizeHandlePoints(frame).map((item) => item.handle)).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
    expect(resizeHandlePoints(frame).find((item) => item.handle === 'e')?.point).toEqual({ x: 100, y: 25 });
    expect(resizeHandlePoints(frame).find((item) => item.handle === 'nw')?.point).toEqual({ x: 0, y: 0 });
  });

  it('resizes an unrotated shape from an edge handle and keeps the opposite edge fixed', () => {
    const { document, manager, object, targets, frame } = setup();
    expect(frame).toMatchObject({ minX: 0, minY: 0, width: 100, height: 50 });
    const plan = prepareResizeObjects(document, targets, frame, 'e', { x: 150, y: 25 })!;
    apply(manager, plan.operations);
    const bounds = boundsOf(document, object.id);
    expect(bounds.minX).toBeCloseTo(0);
    expect(bounds.width).toBeCloseTo(150);
    expect(bounds.height).toBeCloseTo(50);
  });

  it('keeps the aspect ratio on a corner handle when proportional', () => {
    const { document, manager, object, targets, frame } = setup();
    const plan = prepareResizeObjects(document, targets, frame, 'se', { x: 150, y: 100 }, { proportional: true })!;
    apply(manager, plan.operations);
    const bounds = boundsOf(document, object.id);
    // The pointer is 1.5x wide and 2x tall, so the dominant 2x wins on both axes.
    expect(bounds.width).toBeCloseTo(200);
    expect(bounds.height).toBeCloseTo(100);
    expect(bounds.width / bounds.height).toBeCloseTo(2); // the original 100x50 ratio
  });

  it('scales a rotated shape uniformly about the opposite corner', () => {
    const { document, manager, object, targets, frame } = setup(90);
    const plan = prepareResizeObjects(document, targets, frame, 'se', { x: frame.minX + frame.width * 2, y: frame.minY + frame.height * 2 }, { proportional: true })!;
    apply(manager, plan.operations);
    const bounds = boundsOf(document, object.id);
    expect(bounds.width).toBeCloseTo(frame.width * 2);
    expect(bounds.height).toBeCloseTo(frame.height * 2);
    expect(bounds.minX).toBeCloseTo(frame.minX);
    expect(bounds.minY).toBeCloseTo(frame.minY);
  });

  it('never collapses a selection past the minimum span', () => {
    const { document, manager, object, targets, frame } = setup();
    const plan = prepareResizeObjects(document, targets, frame, 'e', { x: 0, y: 25 })!;
    apply(manager, plan.operations);
    expect(boundsOf(document, object.id).width).toBeCloseTo(0.5);
  });

  it('is idempotent: applying the same pointer position twice does not compound', () => {
    const { document, manager, object, targets, frame } = setup();
    const pointer = { x: 175, y: 60 };
    const plan = prepareResizeObjects(document, targets, frame, 'se', pointer)!;
    apply(manager, plan.operations);
    const once = document.getObject(object.id)!.transform;
    const again = prepareResizeObjects(document, targets, frame, 'se', pointer)!;
    // The second plan is built from the same captured baseline, so it must land
    // on identical transforms rather than doubling the scale.
    expect(again.operations).toEqual(plan.operations);
    apply(manager, again.operations);
    expect(document.getObject(object.id)!.transform).toEqual(once);
  });

  it('ignores locked objects', () => {
    const { document, manager, object } = setup();
    const layer = document.getLayerForObject(object.id)!;
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { locked: true } } });
    expect(resizeTargets(document, [object.id])).toHaveLength(0);
    expect(prepareResizeObjects(document, [], { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 }, 'e', { x: 2, y: 0 })).toBeNull();
    expect(selectionFrame(document, [object.id])).toBeDefined();
  });

  it('moves a multi-object selection as one plan with one operation per object', () => {
    const { document, manager, object, frame } = setup();
    const second = addRectangle(document, manager, 20, 20);
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: second.id, updates: { transform: { ...second.transform, x: 200 } } },
    });
    const allTargets = resizeTargets(document, [object.id, second.id]);
    const allFrame = selectionFrame(document, [object.id, second.id])!;
    const plan = prepareResizeObjects(document, allTargets, allFrame, 'e', { x: allFrame.maxX + 100, y: 0 }, { proportional: true })!;
    expect(plan.operations).toHaveLength(2);
    apply(manager, plan.operations);
    expect(boundsOf(document, object.id).width).toBeGreaterThan(100);
    expect(boundsOf(document, second.id).width).toBeGreaterThan(20);
    expect(frame.width).toBe(100);
  });
});
