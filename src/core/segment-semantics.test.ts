import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { OperationManager } from './operations';
import { objectConstructionComposition, selectionIsConstructionOnly } from './segment-semantics';
import { prepareConstructionLineObject } from '../tools/construction-tool';

describe('object construction composition', () => {
  it('distinguishes construction-only, mixed, and artwork objects in the ordinary layer tree', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const prepared = prepareConstructionLineObject(
      document,
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { extent: 'infinite' },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    manager.beginTransaction('Create construction line');
    for (const operation of prepared.plan.operations) manager.execute(operation);
    manager.commitTransaction();

    expect(objectConstructionComposition(document, prepared.plan.objectId)).toBe('construction-only');
    expect(selectionIsConstructionOnly(document, {
      mode: 'object',
      objectIds: new Set([prepared.plan.objectId]),
      nodeIds: new Set(),
      segmentIds: new Set(),
    })).toBe(true);
    expect(selectionIsConstructionOnly(document, {
      mode: 'network',
      editingObjectId: prepared.plan.objectId,
      objectIds: new Set([prepared.plan.objectId]),
      nodeIds: new Set([prepared.plan.nodeIds[0]]),
      segmentIds: new Set(),
    })).toBe(true);

    const extraNodeId = createEntityId();
    const extraSegmentId = createEntityId();
    manager.beginTransaction('Add artwork segment');
    manager.execute({
      type: 'ADD_NODE',
      payload: {
        networkId: prepared.plan.networkId,
        node: { id: extraNodeId, position: { x: 100, y: 50 }, constraintIds: [] },
      },
    });
    manager.execute({
      type: 'ADD_SEGMENT',
      payload: {
        pathId: prepared.plan.pathId,
        segment: {
          id: extraSegmentId,
          startNodeId: prepared.plan.nodeIds[1],
          endNodeId: extraNodeId,
          type: 'line',
          role: 'geometry',
        },
      },
    });
    manager.commitTransaction();
    expect(objectConstructionComposition(document, prepared.plan.objectId)).toBe('mixed');

    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: [{ segmentId: prepared.plan.segmentId, role: 'geometry' }] },
    });
    expect(objectConstructionComposition(document, prepared.plan.objectId)).toBe('artwork');
  });
});
