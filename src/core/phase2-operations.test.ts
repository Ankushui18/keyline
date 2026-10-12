import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { OperationManager } from './operations';
import { evaluateSegment } from './geometry';
import { prepareCutPaths, prepareSplitSegment } from '../tools/cut-tool';
import { adjustHandlePayload, addHandlesFromDrag, convertSegmentFromDrag } from '../tools/bend-tool';
import { buildShapeBuilderResult } from '../tools/shape-builder';
import type { Point, Segment, VectorNode, VectorPath } from './types';

function addPolygon(
  document: VectorDocument,
  manager: OperationManager,
  points: Point[],
  networkId = document.activeNetwork.id,
): VectorPath {
  const nodes: VectorNode[] = points.map((position) => ({ id: createEntityId(), position, constraintIds: [] }));
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: true };
  manager.beginTransaction('Polygon');
  nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId } }));
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  nodes.forEach((node, index) => {
    const segment: Segment = {
      id: createEntityId(),
      startNodeId: node.id,
      endNodeId: nodes[(index + 1) % nodes.length].id,
      type: 'line', role: 'geometry',
    };
    path.segmentIds.push(segment.id);
    // use a payload copy because OperationManager owns the document path copy
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  });
  manager.commitTransaction();
  return document.getPath(path.id)!;
}

describe('Phase 2 operations', () => {
  it('splits a line in-place and restores it with undo', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const path = addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const originalId = path.segmentIds[0];
    const split = prepareSplitSegment(document, originalId, 0.25)!;

    manager.execute({ type: 'SPLIT_SEGMENT', payload: split });
    expect(document.getSegment(originalId)).toBeUndefined();
    expect(document.getNode(split.newNodeId)?.position).toEqual({ x: 25, y: 0 });
    expect(document.getPath(path.id)?.segmentIds.slice(0, 2)).toEqual([split.newSegment1Id, split.newSegment2Id]);

    manager.undo();
    expect(document.getSegment(originalId)).toBeDefined();
    expect(document.getNode(split.newNodeId)).toBeUndefined();
    manager.redo();
    expect(document.getSegment(split.newSegment2Id)).toBeDefined();
  });

  it('blocks topology edits that would orphan a hard constraint', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const path = addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const originalId = path.segmentIds[0];
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint: {
      id: createEntityId(), type: 'horizontal', priority: 'hard', targetIds: [originalId], tolerance: 1e-6,
    } } });
    const split = prepareSplitSegment(document, originalId, 0.5)!;
    expect(() => manager.execute({ type: 'SPLIT_SEGMENT', payload: split })).toThrow(/no longer exists|missing geometry|references geometry/i);
    expect(document.getSegment(originalId)).toBeDefined();
    expect(document.getNode(split.newNodeId)).toBeUndefined();
  });

  it('preserves a cubic curve exactly when splitting with de Casteljau', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const path = addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 100 }]);
    const segment = document.getSegment(path.segmentIds[0])!;
    const conversion = convertSegmentFromDrag(document, segment.id, { x: 60, y: 45 })!;
    manager.execute({ type: 'CONVERT_TO_BEZIER', payload: conversion });
    const original = document.getSegment(segment.id)!;
    const expectedLeft = evaluateSegment(document, original, 0.2);
    const expectedRight = evaluateSegment(document, original, 0.7);
    const split = prepareSplitSegment(document, original.id, 0.4)!;
    manager.execute({ type: 'SPLIT_SEGMENT', payload: split });

    const leftPoint = evaluateSegment(document, document.getSegment(split.newSegment1Id)!, 0.5);
    const rightPoint = evaluateSegment(document, document.getSegment(split.newSegment2Id)!, 0.5);
    expect(leftPoint.x).toBeCloseTo(expectedLeft.x, 6);
    expect(leftPoint.y).toBeCloseTo(expectedLeft.y, 6);
    expect(rightPoint.x).toBeCloseTo(expectedRight.x, 6);
    expect(rightPoint.y).toBeCloseTo(expectedRight.y, 6);
  });

  it('cuts every intersected segment with one semantic operation', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
    const cut = prepareCutPaths(document, { x: -10, y: 50 }, { x: 110, y: 50 })!;
    expect(cut.splits).toHaveLength(2);
    manager.execute({ type: 'CUT_PATHS', payload: cut });
    expect(document.nodes.size).toBe(6);
    expect(document.segments.size).toBe(6);
    manager.undo();
    expect(document.nodes.size).toBe(4);
    expect(document.segments.size).toBe(4);
  });

  it('adds, adjusts, and converts Bézier geometry transactionally', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const path = addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 80 }]);
    const node = document.getNode(document.activeNetwork.nodeIds[0])!;
    const add = addHandlesFromDrag(node, { x: 30, y: 0 });
    manager.execute({ type: 'ADD_BEZIER_HANDLES', payload: add });
    expect(document.getNode(node.id)?.handleIn).toEqual({ x: -30, y: 0 });
    expect(document.connectedSegments(node.id).every((segment) => segment.type === 'bezier')).toBe(true);

    const adjustment = adjustHandlePayload(document.getNode(node.id)!, 'out', { x: 20, y: 20 }, 'mirror');
    manager.execute({ type: 'ADJUST_HANDLE', payload: adjustment });
    expect(document.getNode(node.id)?.handleIn).toEqual({ x: -20, y: -20 });
    manager.undo();
    expect(document.getNode(node.id)?.handleOut).toEqual({ x: 30, y: 0 });

    const line = document.getSegment(path.segmentIds[1])!;
    const convert = convertSegmentFromDrag(document, line.id, { x: 150, y: 40 })!;
    manager.execute({ type: 'CONVERT_TO_BEZIER', payload: convert });
    expect(document.getSegment(line.id)?.type).toBe('bezier');
  });

  it('extracts and merges arrangement regions into new closed paths', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
    addPolygon(document, manager, [{ x: 50, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 100 }, { x: 50, y: 100 }]);
    expect(document.regions).toHaveLength(3);

    const firstId = document.regions[0].id;
    const extract = buildShapeBuilderResult(document, [], [], firstId, false)!;
    manager.execute({ type: extract.type, payload: extract.payload });
    expect(extract.resultPathIds.every((id) => document.getPath(id)?.isClosed)).toBe(true);

    const secondId = document.regions.find((region) => region.id !== firstId)!.id;
    const merge = buildShapeBuilderResult(document, extract.selectedRegionIds, extract.resultPathIds, secondId, false)!;
    manager.execute({ type: merge.type, payload: merge.payload });
    expect(extract.resultPathIds.every((id) => !document.getPath(id))).toBe(true);
    expect(merge.resultPathIds.length).toBeGreaterThan(0);

    const subtract = buildShapeBuilderResult(
      document,
      merge.selectedRegionIds,
      merge.resultPathIds,
      firstId,
      true,
    )!;
    manager.execute({ type: subtract.type, payload: subtract.payload });
    expect(subtract.selectedRegionIds).not.toContain(firstId);
    expect(subtract.resultPathIds.length).toBeGreaterThan(0);
    manager.undo();
    expect(merge.resultPathIds.every((id) => document.getPath(id))).toBe(true);
    manager.undo();
    expect(extract.resultPathIds.every((id) => document.getPath(id))).toBe(true);
  });

  it('materializes Shape Builder output only in the region owner network', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const firstNetworkId = createEntityId();
    const secondNetworkId = createEntityId();
    manager.execute({ type: 'ADD_NETWORK', payload: { network: { id: firstNetworkId, nodeIds: [], pathIds: [] } } });
    manager.execute({ type: 'ADD_NETWORK', payload: { network: { id: secondNetworkId, nodeIds: [], pathIds: [] } } });
    addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }], firstNetworkId);
    addPolygon(document, manager, [{ x: 160, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 80 }, { x: 160, y: 80 }], secondNetworkId);

    const regionNetworkId = (regionId: string) => {
      const region = document.regions.find((item) => item.id === regionId)!;
      const path = document.findPathForSegment(region.boundarySegmentIds[0])!;
      return document.findNetworkForPath(path.id)!.id;
    };
    const firstRegion = document.regions.find((region) => regionNetworkId(region.id) === firstNetworkId)!;
    const secondRegion = document.regions.find((region) => regionNetworkId(region.id) === secondNetworkId)!;
    const firstPathCount = document.getNetwork(firstNetworkId)!.pathIds.length;
    const secondPathCount = document.getNetwork(secondNetworkId)!.pathIds.length;

    const extract = buildShapeBuilderResult(document, [], [], secondRegion.id, false)!;
    expect(extract.payload.networkId).toBe(secondNetworkId);
    expect(extract.payload.patch.addNodes.every((entry) => entry.networkId === secondNetworkId)).toBe(true);
    expect(extract.payload.patch.addPaths.every((entry) => entry.networkId === secondNetworkId)).toBe(true);
    manager.execute({ type: extract.type, payload: extract.payload });
    expect(document.getNetwork(firstNetworkId)!.pathIds).toHaveLength(firstPathCount);
    expect(document.getNetwork(secondNetworkId)!.pathIds).toHaveLength(secondPathCount + 1);

    expect(() => buildShapeBuilderResult(
      document,
      [firstRegion.id],
      [],
      secondRegion.id,
      false,
    )).toThrow('Shape Builder requires regions from a single network.');
    const forgedPayload = { ...extract.payload, networkId: firstNetworkId };
    expect(() => manager.execute({
      type: 'BATCH',
      payload: {
        label: 'Forged ownership',
        operations: [{ type: extract.type, payload: forgedPayload, id: createEntityId(), timestamp: Date.now() }],
      },
    })).toThrow('Shape Builder requires regions from a single network.');
    expect(document.getNetwork(firstNetworkId)!.pathIds).toHaveLength(firstPathCount);
    expect(document.getNetwork(secondNetworkId)!.pathIds).toHaveLength(secondPathCount + 1);
  });
});
