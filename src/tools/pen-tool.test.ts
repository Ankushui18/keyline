import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import { prepareSplitAtPoint } from './cut-tool';
import { PenTool } from './pen-tool';

const click = (pen: PenTool, x: number, y: number) => pen.placePoint({
  position: { x, y },
  closeTolerance: 8,
  allowClose: true,
});

describe('PenTool', () => {
  it('creates an open line path and closes it at the first node', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const pen = new PenTool(manager);

    click(pen, 0, 0);
    click(pen, 100, 0);
    click(pen, 100, 100);
    const closed = click(pen, 2, 2);

    expect(closed.closed).toBe(true);
    expect(document.nodes.size).toBe(3);
    expect(document.segments.size).toBe(3);
    expect([...document.paths.values()][0].isClosed).toBe(true);
    expect(pen.hasActivePath).toBe(false);
  });

  it('creates mirrored handles and a bezier segment from a drag', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const pen = new PenTool(manager);

    click(pen, 0, 0);
    const result = pen.placePoint({
      position: { x: 100, y: 0 },
      handleVector: { x: 20, y: 30 },
      closeTolerance: 8,
      allowClose: false,
    });

    const dragged = document.getNode(result.nodeId!);
    expect(dragged?.handleIn).toEqual({ x: 80, y: -30 });
    expect(dragged?.handleOut).toEqual({ x: 120, y: 30 });
    expect([...document.segments.values()][0].type).toBe('bezier');
  });

  it('exposes a world-space continuation preview and close-target indication', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const pen = new PenTool(manager, { standaloneObjects: true });
    click(pen, 40, 60);
    const firstPreview = pen.continuationPreview({ x: 120, y: 90 }, 8)!;
    expect(firstPreview.start).toEqual({ x: 40, y: 60 });
    expect(firstPreview.cursor).toEqual({ x: 120, y: 90 });
    expect(firstPreview.willClose).toBe(false);

    click(pen, 120, 60);
    click(pen, 120, 140);
    const closingPreview = pen.continuationPreview({ x: 43, y: 62 }, 8)!;
    expect(closingPreview.closeTarget).toEqual({ x: 40, y: 60 });
    expect(closingPreview.willClose).toBe(true);
  });

  it('constrains the next anchor to 45-degree increments from the active endpoint', () => {
    const document = VectorDocument.createEmpty();
    const pen = new PenTool(new OperationManager(document), { standaloneObjects: true });
    click(pen, 40, 60);
    const horizontal = pen.constrainPosition({ x: 137, y: 78 });
    expect(horizontal.y).toBeCloseTo(60, 8);
    expect(horizontal.x).toBeGreaterThan(130);

    const diagonal = pen.constrainPosition({ x: 120, y: 132 });
    expect(diagonal.x - 40).toBeCloseTo(diagonal.y - 60, 8);
  });

  it('continues an open path after undo removes its latest point', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const pen = new PenTool(manager);
    click(pen, 0, 0);
    click(pen, 50, 0);
    manager.undo();
    click(pen, 0, 50);

    expect(document.paths.size).toBe(1);
    expect(document.nodes.size).toBe(2);
    expect(document.segments.size).toBe(1);
  });

  it('ends an open path on escape-equivalent and starts a new path', () => {
    const document = VectorDocument.createEmpty();
    const pen = new PenTool(new OperationManager(document));
    click(pen, 0, 0);
    click(pen, 50, 0);
    pen.endPath();
    click(pen, 0, 50);

    expect(document.paths.size).toBe(2);
    expect(document.nodes.size).toBe(3);
  });

  it('lazily creates a branch path from an existing stable node in the same object network', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const object = document.objectsForArtboard(document.activeArtboardId)[0];
    const network = document.getNetwork(object.networkId)!;
    const pen = new PenTool(manager);
    const first = pen.placePoint({
      position: { x: 0, y: 0 }, closeTolerance: 8, allowClose: true,
      targetNetworkId: network.id, targetObjectId: object.id, coordinateSpace: 'local',
    });
    pen.placePoint({ position: { x: 80, y: 0 }, closeTolerance: 8, allowClose: true });
    pen.endPath();
    const pathsBefore = document.paths.size;

    expect(pen.beginFromNode(first.nodeId!, network.id, object.id)).toBe(true);
    expect(document.paths.size).toBe(pathsBefore);
    const branchEnd = pen.placePoint({ position: { x: 40, y: 50 }, closeTolerance: 8, allowClose: true });

    expect(document.paths.size).toBe(pathsBefore + 1);
    expect(document.getObjectForNode(branchEnd.nodeId!)?.id).toBe(object.id);
    const branchPath = [...document.paths.values()].find((path) =>
      path.segmentIds.some((id) => document.getSegment(id)?.endNodeId === branchEnd.nodeId));
    expect(branchPath).toBeDefined();
    expect(document.getSegment(branchPath!.segmentIds[0])?.startNodeId).toBe(first.nodeId);
  });

  it('connects a branch to an existing node without duplicating graph nodes', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const object = document.objectsForArtboard(document.activeArtboardId)[0];
    const network = document.getNetwork(object.networkId)!;
    const pen = new PenTool(manager);
    const first = pen.placePoint({
      position: { x: 0, y: 0 }, closeTolerance: 8, allowClose: true,
      targetNetworkId: network.id, targetObjectId: object.id, coordinateSpace: 'local',
    });
    const second = pen.placePoint({ position: { x: 80, y: 0 }, closeTolerance: 8, allowClose: true });
    pen.endPath();
    const nodesBefore = document.nodes.size;

    expect(pen.beginFromNode(first.nodeId!, network.id, object.id)).toBe(true);
    const result = pen.connectToNode(second.nodeId!);

    expect(result).toEqual({ connected: true, closed: false });
    expect(document.nodes.size).toBe(nodesBefore);
    const connected = [...document.segments.values()].filter((segment) =>
      segment.startNodeId === first.nodeId && segment.endNodeId === second.nodeId);
    expect(connected).toHaveLength(2);
  });

  it('closes a new branch path by reconnecting to its stable first node', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const object = document.objectsForArtboard(document.activeArtboardId)[0];
    const network = document.getNetwork(object.networkId)!;
    const pen = new PenTool(manager);
    const origin = pen.placePoint({
      position: { x: 0, y: 0 }, closeTolerance: 8, allowClose: true,
      targetNetworkId: network.id, targetObjectId: object.id, coordinateSpace: 'local',
    });
    pen.placePoint({ position: { x: 80, y: 0 }, closeTolerance: 8, allowClose: true });
    pen.endPath();
    const nodesBefore = document.nodes.size;

    pen.beginFromNode(origin.nodeId!, network.id, object.id);
    pen.placePoint({ position: { x: 30, y: 50 }, closeTolerance: 8, allowClose: true });
    pen.placePoint({ position: { x: -20, y: 35 }, closeTolerance: 8, allowClose: true });
    const result = pen.connectToNode(origin.nodeId!);

    expect(result).toEqual({ connected: true, closed: true });
    expect(pen.hasActivePath).toBe(false);
    expect(document.nodes.size).toBe(nodesBefore + 2);
    expect([...document.paths.values()].filter((path) => path.isClosed)).toHaveLength(1);
  });

  it('continues from a node inserted transactionally along an existing segment', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const object = document.objectsForArtboard(document.activeArtboardId)[0];
    const network = document.getNetwork(object.networkId)!;
    const pen = new PenTool(manager);
    pen.placePoint({
      position: { x: 0, y: 0 }, closeTolerance: 8, allowClose: true,
      targetNetworkId: network.id, targetObjectId: object.id, coordinateSpace: 'local',
    });
    pen.placePoint({ position: { x: 100, y: 0 }, closeTolerance: 8, allowClose: true });
    pen.endPath();
    const originalSegment = [...document.segments.values()][0];
    const split = prepareSplitAtPoint(document, originalSegment.id, { x: 45, y: 0 });
    expect(split).toBeDefined();
    manager.execute({ type: 'SPLIT_SEGMENT', payload: split! });

    expect(pen.beginFromNode(split!.newNodeId, network.id, object.id)).toBe(true);
    const branchEnd = pen.placePoint({ position: { x: 45, y: 40 }, closeTolerance: 8, allowClose: true });

    expect(document.getSegment(originalSegment.id)).toBeUndefined();
    expect(document.getNode(split!.newNodeId)?.position).toEqual({ x: 45, y: 0 });
    expect(document.connectedSegments(split!.newNodeId)).toHaveLength(3);
    expect(document.getObjectForNode(branchEnd.nodeId!)?.id).toBe(object.id);

    expect(manager.undo()).toBe(true);
    expect(document.getNode(branchEnd.nodeId!)).toBeUndefined();
    expect(manager.undo()).toBe(true);
    expect(document.getSegment(originalSegment.id)).toBeDefined();
    expect(document.getNode(split!.newNodeId)).toBeUndefined();
  });

  it('creates a standalone styled object and applies live style changes to the active path', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const pen = new PenTool(manager, {
      standaloneObjects: true,
      drawingStyle: {
        strokeEnabled: true, strokeColor: '#ff0000', strokeWidth: 3, strokeCap: 'round', strokeJoin: 'round',
        strokeAlignment: 'center', fillEnabled: false, fillColor: '#8b6cf6',
      },
    });
    const first = click(pen, 40, 60);
    const second = click(pen, 100, 80);

    expect(first.objectId).toBeDefined();
    expect(second.objectId).toBe(first.objectId);
    const object = document.getObject(first.objectId!);
    expect(object?.transform).toMatchObject({ x: 40, y: 60 });
    const network = document.getNetwork(object!.networkId)!;
    expect(document.getNode(network.nodeIds[0])?.position).toEqual({ x: 0, y: 0 });
    expect(document.getNode(network.nodeIds[1])?.position).toEqual({ x: 60, y: 20 });
    expect(document.getAppearance(object!.appearanceId)?.stroke).toMatchObject({ color: '#ff0000', width: 3 });

    pen.setDrawingStyle({
      strokeEnabled: true, strokeColor: '#00ff00', strokeWidth: 7, strokeCap: 'square', strokeJoin: 'bevel',
      strokeAlignment: 'inside', fillEnabled: true, fillColor: '#112233',
    });
    expect(document.getAppearance(object!.appearanceId)?.stroke).toMatchObject({
      color: '#00ff00', width: 7, cap: 'square', join: 'bevel', alignment: 'inside', visible: true,
    });
    expect(document.getAppearance(object!.appearanceId)?.fills[0]?.color).toBe('#112233');

    pen.setDrawingStyle({
      strokeEnabled: false, strokeColor: '#00ff00', strokeWidth: 7, strokeCap: 'square', strokeJoin: 'bevel',
      strokeAlignment: 'outside', fillEnabled: true, fillColor: '#112233',
    });
    expect(document.getAppearance(object!.appearanceId)?.stroke).toMatchObject({
      color: '#00ff00', width: 7, cap: 'square', join: 'bevel', alignment: 'outside', visible: false,
    });
  });
});
