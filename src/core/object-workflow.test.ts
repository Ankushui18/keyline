import { describe, expect, it } from 'vitest';
import { webGLStrokeVertexData } from '../canvas/webgl-renderer';
import { exportDocumentToSvg, concreteDocumentSegments, type ConcreteSegment } from '../export/svg-export';
import { hitTest, hitTestObject, selectionForObjectHit, enterNetworkEditMode, exitNetworkEditMode } from '../tools/select-tool';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import {
  ARTWORK_BOUNDS_POLICY,
  INTERACTION_BOUNDS_POLICY,
  objectBounds,
} from './object-geometry';
import { isArtworkFillPath } from './segment-semantics';
import { Viewport } from '../canvas/viewport';
import { prepareDeleteObject, prepareDuplicateObject, prepareFlipObjects } from './object-operations';
import { OperationManager } from './operations';
import type { Segment, VectorNode, VectorPath } from './types';

function addPath(
  document: VectorDocument,
  manager: OperationManager,
  points: Array<{ x: number; y: number }>,
  closed = false,
): { path: VectorPath; nodes: VectorNode[]; segments: Segment[] } {
  const nodes = points.map((position): VectorNode => ({ id: createEntityId(), position, constraintIds: [] }));
  const segmentCount = closed ? nodes.length : nodes.length - 1;
  const segments = Array.from({ length: segmentCount }, (_, index): Segment => ({
    id: createEntityId(),
    startNodeId: nodes[index].id,
    endNodeId: nodes[(index + 1) % nodes.length].id,
    type: 'line', role: 'geometry',
  }));
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: closed };
  manager.beginTransaction('Fixture path');
  for (const node of nodes) manager.execute({ type: 'ADD_NODE', payload: { node, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId: document.activeNetwork.id } });
  for (const segment of segments) manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { path, nodes, segments };
}

describe('object selection and transforms', () => {
  it('applies object transforms consistently to bounds, concrete rendering, SVG, and hit testing', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { segments } = addPath(document, manager, [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    const object = document.getObjectForSegment(segments[0].id)!;
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: object.id,
        updates: { transform: { x: 100, y: 50, rotation: 90, scaleX: 2, scaleY: 1 } },
      },
    });

    const concrete = concreteDocumentSegments(document).find((item) => item.segment.id === segments[0].id)!;
    expect(concrete.start.x).toBeCloseTo(100);
    expect(concrete.start.y).toBeCloseTo(50);
    expect(concrete.end.x).toBeCloseTo(100);
    expect(concrete.end.y).toBeCloseTo(70);
    expect(objectBounds(document, object.id)).toMatchObject({ minX: 100, minY: 50, width: 0, height: 20 });
    expect(hitTest(document, { x: 100, y: 60 }, 0.5)).toEqual({ kind: 'segment', id: segments[0].id });
    expect(hitTest(document, { x: 5, y: 0 }, 0.5)).toBeNull();
    expect(hitTestObject(document, { x: 100, y: 60 }, 0.5)?.id).toBe(object.id);

    const svg = exportDocumentToSvg(document, { padding: 0, exportBoundsMode: 'artwork' });
    expect(svg).toContain('M100 50L100 70');
    manager.undo();
    expect(document.getObject(object.id)?.transform).toMatchObject({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
  });

  it('uses artwork bounds by default and anchor-only interaction bounds for infinite construction', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { nodes, segments } = addPath(document, manager, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    const object = document.getObjectForSegment(segments[0].id)!;
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: object.id,
        updates: { transform: { x: 20, y: 30, rotation: 0, scaleX: 1, scaleY: 1 } },
      },
    });
    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: {
        segments: [{
          segmentId: segments[0].id,
          role: 'construction',
          constructionExtent: 'infinite',
        }],
      },
    });

    expect(objectBounds(document, object.id, ARTWORK_BOUNDS_POLICY)).toEqual({
      minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0,
    });
    const framingBounds = objectBounds(document, object.id, INTERACTION_BOUNDS_POLICY);
    expect(framingBounds).toEqual({
      minX: 20, minY: 30, maxX: 120, maxY: 30, width: 100, height: 0,
    });
    expect(Object.values(framingBounds).every(Number.isFinite)).toBe(true);

    const viewport = new Viewport();
    viewport.fitBounds(framingBounds, 800, 600, 72);
    const first = viewport.worldToScreen({
      x: nodes[0].position.x + 20,
      y: nodes[0].position.y + 30,
    });
    const second = viewport.worldToScreen({
      x: nodes[1].position.x + 20,
      y: nodes[1].position.y + 30,
    });
    expect(first.x).toBeCloseTo(72, 5);
    expect(second.x).toBeCloseTo(728, 5);
    expect(first.y).toBeCloseTo(300, 5);
    expect(second.y).toBeCloseTo(300, 5);
  });

  it('moves between object selection and explicit network-edit mode', () => {
    const document = VectorDocument.createEmpty();
    const object = [...document.objects.values()][0];
    const objectSelection = selectionForObjectHit(
      { mode: 'object', objectIds: new Set(), nodeIds: new Set(), segmentIds: new Set() },
      { kind: 'object', id: object.id, geometryHit: { kind: 'node', id: 'node-a' } },
      false,
    );
    expect([...objectSelection.objectIds]).toEqual([object.id]);
    const editing = enterNetworkEditMode(document, object.id);
    expect(editing).toMatchObject({ mode: 'network', editingObjectId: object.id });
    expect(exitNetworkEditMode(editing)).toMatchObject({ mode: 'object' });
  });

  it('duplicates a network object with fresh topology IDs as one undoable transaction', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { nodes, segments } = addPath(document, manager, [{ x: 0, y: 0 }, { x: 24, y: 8 }]);
    const source = document.getObjectForSegment(segments[0].id)!;
    const plan = prepareDuplicateObject(document, source.id)!;
    manager.beginTransaction('Duplicate object');
    for (const operation of plan.operations) manager.execute(operation);
    manager.commitTransaction();

    const duplicate = document.getObject(plan.objectId)!;
    const duplicateNetwork = document.getNetwork(duplicate.networkId)!;
    expect(document.objects.size).toBe(2);
    expect(document.networks).toHaveLength(2);
    expect(duplicateNetwork.nodeIds).toHaveLength(2);
    expect(duplicateNetwork.nodeIds).not.toContain(nodes[0].id);
    expect(duplicate.transform).toMatchObject({ x: 16, y: 16 });
    expect(document.getLayerForObject(duplicate.id)?.name).toContain('copy');

    manager.undo();
    expect(document.getObject(plan.objectId)).toBeUndefined();
    expect(document.getNetwork(duplicate.networkId)).toBeUndefined();
    expect(document.objects.size).toBe(1);
    manager.redo();
    expect(document.getObject(plan.objectId)).toBeDefined();

    manager.execute({ type: 'SET_LAYER_ISOLATION', payload: { layerId: plan.layerId } });
    expect(document.isObjectVisible(source.id)).toBe(false);
    expect(document.isObjectVisible(plan.objectId)).toBe(true);
    manager.undo();
    expect(document.isObjectVisible(source.id)).toBe(true);

    const deletion = prepareDeleteObject(document, plan.objectId)!;
    manager.beginTransaction('Delete object');
    for (const operation of deletion.operations) manager.execute(operation);
    manager.commitTransaction();
    expect(document.getObject(plan.objectId)).toBeUndefined();
    expect(document.networks).toHaveLength(1);
    manager.undo();
    expect(document.getObject(plan.objectId)).toBeDefined();
    expect(document.getNetwork(duplicate.networkId)?.nodeIds).toHaveLength(2);
  });

  it('flips single and multi-object selections around the visible selection center with atomic undo', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { segments } = addPath(document, manager, [{ x: 0, y: 0 }, { x: 20, y: 10 }]);
    const first = document.getObjectForSegment(segments[0].id)!;
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: first.id, updates: { transform: { x: 10, y: 8, rotation: 25, scaleX: 1.5, scaleY: 0.75 } } },
    });

    const beforeSingle = objectBounds(document, first.id, INTERACTION_BOUNDS_POLICY);
    const singlePlan = prepareFlipObjects(document, [first.id], 'horizontal')!;
    manager.beginTransaction('Flip horizontal');
    for (const operation of singlePlan.operations) manager.execute(operation);
    manager.commitTransaction();
    const afterSingle = objectBounds(document, first.id, INTERACTION_BOUNDS_POLICY);
    expect(afterSingle.minX).toBeCloseTo(beforeSingle.minX);
    expect(afterSingle.maxX).toBeCloseTo(beforeSingle.maxX);
    expect(afterSingle.minY).toBeCloseTo(beforeSingle.minY);
    expect(afterSingle.maxY).toBeCloseTo(beforeSingle.maxY);
    expect(document.getObject(first.id)?.transform).toMatchObject({ rotation: -25, scaleX: -1.5, scaleY: 0.75 });
    manager.undo();
    expect(document.getObject(first.id)?.transform).toMatchObject({ x: 10, y: 8, rotation: 25, scaleX: 1.5, scaleY: 0.75 });

    const duplicatePlan = prepareDuplicateObject(document, first.id)!;
    manager.beginTransaction('Create second object');
    for (const operation of duplicatePlan.operations) manager.execute(operation);
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: duplicatePlan.objectId, updates: { transform: { x: 70, y: 18, rotation: -10, scaleX: 0.8, scaleY: 1.2 } } },
    });
    manager.commitTransaction();
    const second = document.getObject(duplicatePlan.objectId)!;
    const firstBefore = { ...document.getObject(first.id)!.transform };
    const secondBefore = { ...second.transform };
    const combinedBefore = [first.id, second.id].map((id) => objectBounds(document, id, INTERACTION_BOUNDS_POLICY));
    const selectionCenterY = (
      Math.min(...combinedBefore.map((bounds) => bounds.minY)) +
      Math.max(...combinedBefore.map((bounds) => bounds.maxY))
    ) / 2;

    const multiPlan = prepareFlipObjects(document, [first.id, second.id], 'vertical')!;
    manager.beginTransaction('Flip vertical');
    for (const operation of multiPlan.operations) manager.execute(operation);
    manager.commitTransaction();
    expect(document.getObject(first.id)?.transform.y).toBeCloseTo(2 * selectionCenterY - firstBefore.y);
    expect(document.getObject(second.id)?.transform.y).toBeCloseTo(2 * selectionCenterY - secondBefore.y);
    expect(document.getObject(first.id)?.transform.scaleY).toBeCloseTo(-firstBefore.scaleY);
    expect(document.getObject(second.id)?.transform.rotation).toBeCloseTo(-secondBefore.rotation);
    manager.undo();
    expect(document.getObject(first.id)?.transform).toEqual(firstBefore);
    expect(document.getObject(second.id)?.transform).toEqual(secondBefore);
  });

  it('tessellates WebGL stroke width, square caps, and dash patterns into filled geometry', () => {
    const concrete: ConcreteSegment = {
      segment: { id: 'stroke-segment', startNodeId: 'a', endNodeId: 'b', type: 'line', role: 'geometry' },
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
    };
    const solid = webGLStrokeVertexData(concrete, 4, 'square');
    const solidXs = solid.filter((_, index) => index % 6 === 0);
    const solidYs = solid.filter((_, index) => index % 6 === 1);
    expect(Math.min(...solidXs)).toBeCloseTo(-2);
    expect(Math.max(...solidXs)).toBeCloseTo(12);
    expect(Math.min(...solidYs)).toBeCloseTo(-2);
    expect(Math.max(...solidYs)).toBeCloseTo(2);
    const dashed = webGLStrokeVertexData(concrete, 2, 'butt', [2, 2]);
    const dashedXs = dashed.filter((_, index) => index % 6 === 0);
    expect(dashed.length).toBeGreaterThan(solid.length);
    expect(dashedXs).toContain(4);
    expect(dashedXs).not.toContain(3);
  });

  it('exports persistent object fills for closed paths and honors appearance opacity', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { segments } = addPath(document, manager, [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 },
    ], true);
    const object = document.getObjectForSegment(segments[0].id)!;
    const appearance = document.getAppearance(object.appearanceId)!;
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: {
        appearanceId: appearance.id,
        updates: {
          fills: [{ type: 'solid', color: '#ff3366', opacity: 0.5, visible: true }],
          stroke: appearance.stroke ? { ...appearance.stroke, visible: false } : undefined,
          opacity: 0.8,
        },
      },
    });
    const svg = exportDocumentToSvg(document, { includeMetadata: true });
    expect(svg).toContain(`data-object-id="${object.id}"`);
    expect(svg).toContain('fill="#ff3366"');
    expect(svg).toContain('fill-opacity="0.4"');
    expect(svg).not.toContain('data-segment-id=');
  });

  it('rejects mixed construction paths as object-fill boundaries in the shared Canvas, WebGL, and SVG policy', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { path, segments } = addPath(document, manager, [
      { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 },
    ], true);
    const object = document.getObjectForSegment(segments[0].id)!;
    const appearance = document.getAppearance(object.appearanceId)!;
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: {
        appearanceId: appearance.id,
        updates: {
          fills: [{ type: 'solid', color: '#f04b78', opacity: 1, visible: true }],
          stroke: appearance.stroke ? { ...appearance.stroke, visible: false } : undefined,
        },
      },
    });
    expect(isArtworkFillPath(document, path.id)).toBe(true);
    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: {
        segments: [{
          segmentId: segments[0].id,
          role: 'construction',
          constructionExtent: 'finite',
        }],
      },
    });

    expect(isArtworkFillPath(document, path.id)).toBe(false);
    expect(document.regions).toHaveLength(0);
    const svg = exportDocumentToSvg(document, { includeMetadata: true });
    expect(svg).not.toContain(`data-object-id="${object.id}"`);
    expect(svg).not.toContain('fill="#f04b78"');
  });

  it('composes object transforms with filled live-repeat instances during export', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { path, segments } = addPath(document, manager, [
      { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 },
    ], true);
    const object = document.getObjectForSegment(segments[0].id)!;
    const appearance = document.getAppearance(object.appearanceId)!;
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: object.id, updates: { transform: { ...object.transform, x: 100, y: 50 } } },
    });
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: { appearanceId: appearance.id, updates: { fills: [{ type: 'solid', color: '#00cc88', opacity: 1, visible: true }] } },
    });
    manager.execute({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: {
        group: {
          id: createEntityId(),
          name: 'Repeat 2',
          sourcePathIds: [path.id],
          transform: { type: 'repeat', center: { x: 0, y: 0 }, count: 2, sweepAngle: 360 },
        },
      },
    });
    const svg = exportDocumentToSvg(document, { exportBoundsMode: 'artwork', includeMetadata: true });
    expect(svg.match(new RegExp(`data-object-id="${object.id}"`, 'g'))).toHaveLength(2);
    expect(svg).toContain('M110 50');
    expect(svg).toContain('M90 50');
  });
});
