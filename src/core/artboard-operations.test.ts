import { describe, expect, it } from 'vitest';
import { deleteArtboardsTransactional, prepareCreateIconArtboard, prepareDuplicateArtboard } from './artboard-operations';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { OperationManager } from './operations';
import type { Segment, VectorNode, VectorPath } from './types';

function executePlan(manager: OperationManager, label: string, operations: ReturnType<typeof prepareCreateIconArtboard>['operations']) {
  manager.beginTransaction(label);
  operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
}

describe('icon artboard operations', () => {
  it('creates a named, drawable icon frame atomically', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const originalArtboardId = document.activeArtboardId;
    const originalFrame = { ...document.activeArtboard.frame };
    const plan = prepareCreateIconArtboard(document, 24, 24);

    executePlan(manager, 'Add icon frame', plan.operations);
    expect(document.activeArtboardId).toBe(plan.artboard.id);
    expect(document.activeArtboard.name).toBe('Icon 24');
    expect(document.activeArtboard.frame).toEqual({ x: 0, y: 0, width: 24, height: 24 });
    expect(document.artboards.size).toBe(1);
    expect(document.activeArtboardId).toBe(originalArtboardId);
    expect(document.objectsForArtboard(plan.artboard.id)).toHaveLength(1);
    expect(document.activeNetwork.nodeIds).toHaveLength(0);

    expect(manager.undo()).toBe(true);
    expect(document.activeArtboardId).toBe(originalArtboardId);
    expect(document.activeArtboard.name).toBe('Artboard 1');
    expect(document.activeArtboard.frame).toEqual(originalFrame);
    expect(document.artboards.size).toBe(1);
    expect(manager.redo()).toBe(true);
    expect(document.activeArtboardId).toBe(plan.artboard.id);
    expect(document.activeArtboard.name).toBe('Icon 24');
    expect(document.artboards.size).toBe(1);
  });

  it('duplicates frame dimensions and graph-backed content with fresh IDs', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const source = document.activeArtboard;
    manager.execute({
      type: 'UPDATE_ARTBOARD_DIMENSIONS',
      payload: { artboardId: source.id, width: 32, height: 32 },
    });
    const networkId = document.activeNetwork.id;
    const first: VectorNode = { id: createEntityId(), position: { x: -8, y: -8 }, constraintIds: [] };
    const second: VectorNode = { id: createEntityId(), position: { x: 8, y: 8 }, constraintIds: [] };
    const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
    const segment: Segment = {
      id: createEntityId(), startNodeId: first.id, endNodeId: second.id, type: 'line', role: 'geometry',
    };
    manager.beginTransaction('Source content');
    manager.execute({ type: 'ADD_NODE', payload: { node: first, networkId } });
    manager.execute({ type: 'ADD_NODE', payload: { node: second, networkId } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
    manager.commitTransaction();

    const plan = prepareDuplicateArtboard(document, source.id)!;
    executePlan(manager, 'Duplicate artboard', plan.operations);
    const duplicate = document.activeArtboard;
    expect(duplicate.id).toBe(plan.artboard.id);
    expect(duplicate.frame.width).toBe(32);
    expect(duplicate.frame.height).toBe(32);
    expect(duplicate.name).toBe('Artboard 1 copy');
    expect(plan.objectIds.every((id) => document.getObject(id))).toBe(true);
    const duplicateSegments = document.objectsForArtboard(duplicate.id)
      .flatMap((object) => document.getNetwork(object.networkId)?.pathIds ?? [])
      .flatMap((pathId) => document.getPath(pathId)?.segmentIds ?? []);
    expect(duplicateSegments).toHaveLength(1);
    expect(duplicateSegments[0]).not.toBe(segment.id);

    expect(manager.undo()).toBe(true);
    expect(document.getArtboard(duplicate.id)).toBeUndefined();
    expect(document.getSegment(segment.id)).toBeDefined();
  });

  it('deletes a populated artboard transactionally and restores its graph, layers, and active location on undo', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const source = document.activeArtboard;
    const networkId = document.activeNetwork.id;
    const first: VectorNode = { id: createEntityId(), position: { x: 2, y: 3 }, constraintIds: [] };
    const second: VectorNode = { id: createEntityId(), position: { x: 18, y: 19 }, constraintIds: [] };
    const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
    const segment: Segment = {
      id: createEntityId(), startNodeId: first.id, endNodeId: second.id, type: 'line', role: 'geometry',
    };
    manager.beginTransaction('Source artwork');
    manager.execute({ type: 'ADD_NODE', payload: { node: first, networkId } });
    manager.execute({ type: 'ADD_NODE', payload: { node: second, networkId } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
    manager.commitTransaction();
    const duplicate = prepareDuplicateArtboard(document, source.id)!;
    executePlan(manager, 'Duplicate artboard', duplicate.operations);
    manager.execute({
      type: 'SET_ACTIVE_LOCATION',
      payload: { pageId: source.pageId, artboardId: source.id },
    });
    const sourceObjectIds = document.objectsForArtboard(source.id).map((object) => object.id);

    const result = deleteArtboardsTransactional(manager, [source.id]);
    expect(result?.artboardIds).toEqual([source.id]);
    expect(document.getArtboard(source.id)).toBeUndefined();
    expect(document.getNode(first.id)).toBeUndefined();
    expect(sourceObjectIds.every((id) => !document.getObject(id))).toBe(true);
    expect(document.activeArtboardId).toBe(duplicate.artboard.id);

    expect(manager.undo()).toBe(true);
    expect(document.getArtboard(source.id)).toBeDefined();
    expect(document.getNode(first.id)).toMatchObject(first);
    expect(document.getSegment(segment.id)).toMatchObject(segment);
    expect(sourceObjectIds.every((id) => document.getObject(id))).toBe(true);
    expect(document.activeArtboardId).toBe(source.id);
  });

  it('deletes the final visible artboard into an undoable page-level Canvas root', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const originalId = document.activeArtboardId;
    const result = deleteArtboardsTransactional(manager, [originalId]);
    expect(result?.artboardIds).toEqual([originalId]);
    expect(document.getArtboard(originalId)).toBeUndefined();
    expect(document.artboards.size).toBe(1);
    expect(document.activeArtboard.isCanvasRoot).toBe(true);
    expect(document.activeArtboard.name).toBe('Canvas');

    expect(manager.undo()).toBe(true);
    expect(document.getArtboard(originalId)).toBeDefined();
    expect(document.activeArtboardId).toBe(originalId);
    expect([...document.artboards.values()].some((artboard) => artboard.isCanvasRoot)).toBe(false);
  });
});
