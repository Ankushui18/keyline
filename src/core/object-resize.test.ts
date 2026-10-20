import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import type { GeometryBounds } from './object-geometry';
import {
  frameCenter,
  frameHandlePoints,
  frameHitTarget,
  framePoint,
  prepareResizeObjects,
  prepareRotateObjects,
  selectionFrame,
  transformTargets,
  type SelectionFrame,
} from './object-resize';
import { OperationManager } from './operations';
import type { OperationInput } from './operations';
import type { EntityId, NetworkObject, Segment, VectorNode, VectorPath } from './types';

function addRectangle(
  document: VectorDocument,
  manager: OperationManager,
  width = 100,
  height = 50,
  offsetX = 0,
): NetworkObject {
  const corners = [
    { x: offsetX, y: 0 },
    { x: offsetX + width, y: 0 },
    { x: offsetX + width, y: height },
    { x: offsetX, y: height },
  ];
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
  manager.beginTransaction('Transform objects');
  for (const operation of operations) manager.execute(operation);
  manager.commitTransaction();
}

const span = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);

function frameOf(document: VectorDocument, objectIds: EntityId[]): SelectionFrame {
  return selectionFrame(document, objectIds)!;
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
  const targets = transformTargets(document, [object.id]);
  return { document, manager, objectId: object.id, targets, frame: frameOf(document, [object.id]) };
}

function boundsOf(document: VectorDocument, objectId: EntityId): GeometryBounds {
  const frame = frameOf(document, [objectId]);
  const xs = frame.corners.map((point) => point.x);
  const ys = frame.corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, maxX: Math.max(...xs), maxY: Math.max(...ys), width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

describe('selection frame', () => {
  it('addresses handles in frame coordinates', () => {
    const { frame } = setup();
    expect(framePoint(frame, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(framePoint(frame, 1, 0.5)).toEqual({ x: 100, y: 25 });
    expect(frameCenter(frame)).toEqual({ x: 50, y: 25 });
    const handles = frameHandlePoints(frame);
    expect(handles.map((item) => item.handle)).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
    expect(handles.find((item) => item.handle === 'e')?.point).toEqual({ x: 100, y: 25 });
  });

  it('turns the corner zone outside the box into a rotate target', () => {
    const { frame } = setup();
    // On a handle: resize wins.
    expect(frameHitTarget(frame, { x: 100, y: 0 }, { scale: 1 })).toBe('ne');
    // Just outside the corner, past the handle square: rotate, like Figma.
    expect(frameHitTarget(frame, { x: 110, y: -10 }, { scale: 1 })).toBe('rotate');
    // Inside the box: nothing, so dragging still moves the object.
    expect(frameHitTarget(frame, { x: 90, y: 10 }, { scale: 1 })).toBeUndefined();
    // Outside, but past the zone: nothing.
    expect(frameHitTarget(frame, { x: 160, y: -60 }, { scale: 1 })).toBeUndefined();
    // The zone is screen sized, so it shrinks in world units when zoomed in.
    expect(frameHitTarget(frame, { x: 110, y: -10 }, { scale: 4 })).toBeUndefined();
    expect(frameHitTarget(frame, { x: 103, y: -2 }, { scale: 4 })).toBe('rotate');
  });

  it('follows a single object’s own axes and records its rotation', () => {
    const { frame } = setup(30);
    expect(frame.oriented).toBe(true);
    expect(frame.rotation).toBeCloseTo(30);
    expect(span(frame.corners[0], frame.corners[1])).toBeCloseTo(100);
    expect(span(frame.corners[0], frame.corners[3])).toBeCloseTo(50);
  });

  it('falls back to a shared axis-aligned frame for several objects', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = addRectangle(document, manager);
    const second = addRectangle(document, manager, 20, 20, 200);
    const frame = selectionFrame(document, [first.id, second.id])!;
    expect(frame.oriented).toBe(false);
    expect(frame.rotation).toBe(0);
    expect(frame.corners[0]).toEqual({ x: 0, y: 0 });
    expect(frame.corners[2]).toEqual({ x: 220, y: 50 });
  });
});

describe('object resize', () => {
  it('resizes an unrotated shape from an edge handle and keeps the opposite edge fixed', () => {
    const { document, manager, objectId, targets, frame } = setup();
    const plan = prepareResizeObjects(targets, frame, 'e', { x: 150, y: 25 })!;
    apply(manager, plan.operations);
    const bounds = boundsOf(document, objectId);
    expect(bounds.minX).toBeCloseTo(0);
    expect(bounds.width).toBeCloseTo(150);
    expect(bounds.height).toBeCloseTo(50);
  });

  it('keeps the aspect ratio on a corner handle when proportional', () => {
    const { document, manager, objectId, targets, frame } = setup();
    const plan = prepareResizeObjects(targets, frame, 'se', { x: 150, y: 100 }, { proportional: true })!;
    apply(manager, plan.operations);
    const bounds = boundsOf(document, objectId);
    // The pointer is 1.5x wide and 2x tall, so the dominant 2x wins on both axes.
    expect(bounds.width).toBeCloseTo(200);
    expect(bounds.height).toBeCloseTo(100);
  });

  it('resizes a rotated shape exactly in its own axes', () => {
    const { document, manager, objectId, targets, frame } = setup(35);
    const before = frame;
    const plan = prepareResizeObjects(targets, frame, 'e', framePoint(before, 2, 0.5))!;
    apply(manager, plan.operations);
    const after = frameOf(document, [objectId]);
    // The near corner does not move, the grabbed edge doubles, the other edge holds.
    expect(span(after.corners[0], before.corners[0])).toBeCloseTo(0);
    expect(span(after.corners[0], after.corners[1])).toBeCloseTo(200);
    expect(span(after.corners[0], after.corners[3])).toBeCloseTo(50);
  });

  it('never collapses a selection past the minimum span', () => {
    const { document, manager, objectId, targets, frame } = setup();
    const plan = prepareResizeObjects(targets, frame, 'e', { x: 0, y: 25 })!;
    apply(manager, plan.operations);
    expect(boundsOf(document, objectId).width).toBeCloseTo(0.5);
  });

  it('is idempotent: applying the same pointer position twice does not compound', () => {
    const { document, manager, objectId, targets, frame } = setup();
    const pointer = { x: 175, y: 60 };
    const plan = prepareResizeObjects(targets, frame, 'se', pointer)!;
    apply(manager, plan.operations);
    const once = document.getObject(objectId)!.transform;
    const again = prepareResizeObjects(targets, frame, 'se', pointer)!;
    // The second plan is built from the same captured baseline, so it must land on
    // identical transforms rather than doubling the scale.
    expect(again.operations).toEqual(plan.operations);
    apply(manager, again.operations);
    expect(document.getObject(objectId)!.transform).toEqual(once);
  });

  it('ignores locked objects', () => {
    const { document, manager, objectId } = setup();
    const layer = document.getLayerForObject(objectId)!;
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { locked: true } } });
    expect(transformTargets(document, [objectId])).toHaveLength(0);
    expect(prepareResizeObjects([], frameOf(document, [objectId]), 'e', { x: 2, y: 0 })).toBeNull();
  });

  it('resizes a multi-object selection with one operation per object', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = addRectangle(document, manager);
    const second = addRectangle(document, manager, 20, 20, 200);
    const targets = transformTargets(document, [first.id, second.id]);
    const frame = frameOf(document, [first.id, second.id]);
    const plan = prepareResizeObjects(targets, frame, 'e', { x: frame.corners[2].x + 100, y: 25 }, { proportional: true })!;
    expect(plan.operations).toHaveLength(2);
    apply(manager, plan.operations);
    expect(boundsOf(document, first.id).width).toBeGreaterThan(100);
    expect(boundsOf(document, second.id).width).toBeGreaterThan(20);
  });
});

describe('object rotation', () => {
  it('rotates a single object around the frame centre', () => {
    const { document, manager, objectId, targets, frame } = setup();
    const center = frameCenter(frame);
    const plan = prepareRotateObjects(targets, frame, { x: center.x + 40, y: center.y }, { x: center.x, y: center.y + 40 })!;
    apply(manager, plan.operations);
    expect(document.getObject(objectId)!.transform.rotation).toBeCloseTo(90);
    const bounds = boundsOf(document, objectId);
    expect(bounds.width).toBeCloseTo(50);
    expect(bounds.height).toBeCloseTo(100);
    expect(bounds.minX + bounds.width / 2).toBeCloseTo(center.x);
    expect(bounds.minY + bounds.height / 2).toBeCloseTo(center.y);
  });

  it('snaps the absolute rotation to 15 degree steps with shift', () => {
    const { document, manager, objectId, targets, frame } = setup();
    const center = frameCenter(frame);
    const radius = 40;
    const start = { x: center.x + radius, y: center.y };
    const angle = 20 * Math.PI / 180;
    const pointer = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
    const plan = prepareRotateObjects(targets, frame, start, pointer, { snap: true })!;
    apply(manager, plan.operations);
    expect(document.getObject(objectId)!.transform.rotation).toBeCloseTo(15);
  });

  it('returns no plan when the pointer has not moved', () => {
    const { targets, frame } = setup();
    const center = frameCenter(frame);
    expect(prepareRotateObjects(targets, frame, center, center)).toBeNull();
  });

  it('rotates a multi-selection about the shared centre, keeping relative positions', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = addRectangle(document, manager);
    const second = addRectangle(document, manager, 20, 20, 200);
    const targets = transformTargets(document, [first.id, second.id]);
    const frame = frameOf(document, [first.id, second.id]);
    const center = frameCenter(frame);
    const beforeFirst = frameCenter(frameOf(document, [first.id]));
    const plan = prepareRotateObjects(targets, frame, { x: center.x + 100, y: center.y }, { x: center.x, y: center.y + 100 })!;
    apply(manager, plan.operations);
    expect(document.getObject(first.id)!.transform.rotation).toBeCloseTo(90);
    expect(document.getObject(second.id)!.transform.rotation).toBeCloseTo(90);
    const afterFirst = frameCenter(frameOf(document, [first.id]));
    // The quarter turn about the shared centre moves each object with the group.
    expect(afterFirst.x).toBeCloseTo(center.x - (beforeFirst.y - center.y));
    expect(afterFirst.y).toBeCloseTo(center.y + (beforeFirst.x - center.x));
  });
});

describe('readout orientation', () => {
  // The pill must never render upside down: past a quarter turn it hangs from the
  // top edge, rotated back into the readable half turn.
  const readable = (rotation: number) => {
    const normalized = ((rotation % 360) + 360) % 360;
    return normalized > 90 && normalized < 270 ? rotation + 180 : rotation;
  };
  const degrees = (value: number) => ((value % 360) + 360) % 360;

  it('keeps the label upright across a full turn', () => {
    for (let rotation = -360; rotation <= 360; rotation += 5) {
      const angle = degrees(readable(rotation));
      expect(angle <= 90 || angle >= 270).toBe(true);
    }
  });

  it('measures the frame the way the readout prints it', () => {
    const { frame } = setup(37);
    const width = Math.hypot(frame.corners[1].x - frame.corners[0].x, frame.corners[1].y - frame.corners[0].y);
    const height = Math.hypot(frame.corners[3].x - frame.corners[0].x, frame.corners[3].y - frame.corners[0].y);
    // Per-object size, not the axis-aligned bounding box: 100 x 50 stays 100 x 50.
    expect(width).toBeCloseTo(100);
    expect(height).toBeCloseTo(50);
  });
});
