import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { objectBounds } from '../core/object-geometry';
import { OperationManager } from '../core/operations';
import { exportDocumentToSvg } from '../export/svg-export';
import { preparePrimitiveObject } from './primitive-tool';

function commitPlan(manager: OperationManager, plan: NonNullable<ReturnType<typeof preparePrimitiveObject>>) {
  manager.beginTransaction(`Create ${plan.kind}`);
  for (const operation of plan.operations) manager.execute(operation);
  manager.commitTransaction();
}

describe('primitive network conversion', () => {
  it('creates a rectangle as a standalone closed network object and undoes atomically', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = preparePrimitiveObject(document, 'rectangle', { x: 20, y: 30 }, { x: 120, y: 80 })!;
    commitPlan(manager, plan);

    const object = document.getObject(plan.objectId)!;
    const network = document.getNetwork(plan.networkId)!;
    const path = document.getPath(plan.pathId)!;
    expect(object.transform).toMatchObject({ x: 20, y: 30, scaleX: 1, scaleY: 1 });
    expect(network.nodeIds).toHaveLength(4);
    expect(path.isClosed).toBe(true);
    expect(path.segmentIds).toHaveLength(4);
    expect(path.segmentIds.every((id) => document.getSegment(id)?.type === 'line')).toBe(true);
    expect(objectBounds(document, object.id)).toMatchObject({ minX: 20, minY: 30, maxX: 120, maxY: 80, width: 100, height: 50 });
    expect(exportDocumentToSvg(document, { includeMetadata: true })).toContain(`data-object-id="${object.id}"`);

    manager.undo();
    expect(document.getObject(plan.objectId)).toBeUndefined();
    expect(document.getNetwork(plan.networkId)).toBeUndefined();
    manager.redo();
    expect(document.getPath(plan.pathId)?.segmentIds).toHaveLength(4);
  });

  it('creates an ellipse from four cubic segments with valid mirrored handles', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = preparePrimitiveObject(document, 'ellipse', { x: 10, y: 15 }, { x: 90, y: 55 })!;
    commitPlan(manager, plan);

    const network = document.getNetwork(plan.networkId)!;
    const nodes = network.nodeIds.map((id) => document.getNode(id)!);
    expect(nodes).toHaveLength(4);
    expect(nodes.every((node) => node.handleIn && node.handleOut)).toBe(true);
    expect(plan.segmentIds.every((id) => document.getSegment(id)?.type === 'bezier')).toBe(true);
    expect(objectBounds(document, plan.objectId)).toMatchObject({ minX: 10, minY: 15, maxX: 90, maxY: 55, width: 80, height: 40 });
    manager.execute({ type: 'SET_NODE_MODES', payload: { modes: [{ nodeId: nodes[0].id, mode: 'smooth' }] } });
    expect(document.getNode(nodes[0].id)?.handleMode).toBe('smooth');
    expect(new VectorDocument(document.toSnapshot()).getNode(nodes[0].id)?.handleMode).toBe('smooth');
    manager.undo();
    expect(document.getNode(nodes[0].id)?.handleMode).toBeUndefined();
    manager.redo();
    expect(document.getNode(nodes[0].id)?.handleMode).toBe('smooth');
  });

  it('converts rounded rectangles, polygons, stars, lines, and arcs into valid network topology', () => {
    const document = VectorDocument.createEmpty();
    const rounded = preparePrimitiveObject(document, 'rounded-rectangle', { x: 0, y: 0 }, { x: 100, y: 40 }, { cornerRadius: 50 })!;
    const roundedSegments = rounded.operations.filter((operation) => operation.type === 'ADD_SEGMENT')
      .map((operation) => (operation.payload as { segment: { type: string; radius?: number } }).segment);
    expect(roundedSegments).toHaveLength(8);
    expect(roundedSegments.filter((segment) => segment.type === 'arc')).toHaveLength(4);
    expect(roundedSegments.filter((segment) => segment.type === 'arc').every((segment) => segment.radius === 20)).toBe(true);

    const polygon = preparePrimitiveObject(document, 'polygon', { x: 0, y: 0 }, { x: 80, y: 80 }, { sides: 7 })!;
    expect(polygon.nodeIds).toHaveLength(7);
    expect(polygon.segmentIds).toHaveLength(7);
    const star = preparePrimitiveObject(document, 'star', { x: 0, y: 0 }, { x: 80, y: 80 }, { sides: 6, starInnerRatio: 0.4 })!;
    expect(star.nodeIds).toHaveLength(12);

    const line = preparePrimitiveObject(document, 'line', { x: 10, y: 10 }, { x: 70, y: 10 })!;
    expect(line.nodeIds).toHaveLength(2);
    expect(line.segmentIds).toHaveLength(1);
    const lineAppearance = (line.operations.find((operation) => operation.type === 'ADD_APPEARANCE')!.payload as {
      appearance: { stroke?: { color: string; width: number; cap: string } };
    }).appearance;
    expect(lineAppearance.stroke).toMatchObject({ color: '#000000', width: 1, cap: 'butt' });
    const arc = preparePrimitiveObject(document, 'arc', { x: 0, y: 0 }, { x: 100, y: 60 })!;
    const arcSegment = (arc.operations.find((operation) => operation.type === 'ADD_SEGMENT')!.payload as { segment: { type: string; radius: number } }).segment;
    expect(arcSegment).toMatchObject({ type: 'arc', role: 'geometry', radius: 30 });
  });

  it('owns inside artwork by its frame and outside artwork by a separate Canvas root', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const frameId = document.activeArtboardId;
    const inside = preparePrimitiveObject(document, 'rectangle', { x: 0, y: 0 }, { x: 40, y: 40 })!;
    commitPlan(manager, inside);
    expect(document.getLayerForObject(inside.objectId)?.artboardId).toBe(frameId);
    expect([...document.artboards.values()].some((artboard) => artboard.isCanvasRoot)).toBe(false);

    const outside = preparePrimitiveObject(document, 'rectangle', { x: 600, y: 0 }, { x: 650, y: 50 })!;
    commitPlan(manager, outside);
    const canvasRoot = [...document.artboards.values()].find((artboard) => artboard.isCanvasRoot);
    expect(canvasRoot).toBeDefined();
    expect(document.getLayerForObject(outside.objectId)?.artboardId).toBe(canvasRoot?.id);
    expect(document.activeArtboardId).toBe(canvasRoot?.id);

    expect(manager.undo()).toBe(true);
    expect(document.getObject(outside.objectId)).toBeUndefined();
    expect([...document.artboards.values()].some((artboard) => artboard.isCanvasRoot)).toBe(false);
    expect(document.activeArtboardId).toBe(frameId);
  });

  it('supports constrained and center-origin construction without renderer-derived geometry', () => {
    const document = VectorDocument.createEmpty();
    const square = preparePrimitiveObject(
      document, 'rectangle', { x: 50, y: 50 }, { x: 80, y: 70 }, { constrain: true, fromCenter: true },
    )!;
    const objectOperation = square.operations.find((operation) => operation.type === 'ADD_OBJECT')!;
    const object = (objectOperation.payload as { object: { transform: { x: number; y: number } } }).object;
    expect(object.transform).toMatchObject({ x: 20, y: 20 });
    const nodeOperations = square.operations.filter((operation) => operation.type === 'ADD_NODE');
    const positions = nodeOperations.map((operation) =>
      (operation.payload as { node: { position: { x: number; y: number } } }).node.position,
    );
    expect(Math.max(...positions.map((point) => point.x))).toBe(60);
    expect(Math.max(...positions.map((point) => point.y))).toBe(60);
    expect(preparePrimitiveObject(document, 'ellipse', { x: 1, y: 1 }, { x: 1, y: 1 })).toBeNull();
  });
});
