import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import { prepareConstructionLineObject } from './construction-tool';

describe('construction line authoring', () => {
  it('prepares and atomically commits one ordinary infinite construction object', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const initialObjectCount = document.objects.size;
    const prepared = prepareConstructionLineObject(
      document,
      { x: 20, y: 30 },
      { x: 120, y: 70 },
      { extent: 'infinite' },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    manager.beginTransaction('Create construction line');
    for (const operation of prepared.plan.operations) manager.execute(operation);
    manager.commitTransaction();

    expect(document.objects.size).toBe(initialObjectCount + 1);
    const object = document.getObject(prepared.plan.objectId);
    const layer = document.getLayer(prepared.plan.layerId);
    const network = document.getNetwork(prepared.plan.networkId);
    const segment = document.getSegment(prepared.plan.segmentId);
    expect(object?.transform).toMatchObject({ x: 20, y: 30 });
    expect(layer).toMatchObject({ kind: 'object', objectId: prepared.plan.objectId });
    expect(network?.nodeIds).toEqual(prepared.plan.nodeIds);
    expect(segment).toMatchObject({
      type: 'line',
      role: 'construction',
      constructionExtent: 'infinite',
    });

    manager.undo();
    expect(document.getObject(prepared.plan.objectId)).toBeUndefined();
    expect(document.getSegment(prepared.plan.segmentId)).toBeUndefined();
  });

  it('constrains Shift drags to 45-degree direction increments', () => {
    const document = VectorDocument.createEmpty();
    const prepared = prepareConstructionLineObject(
      document,
      { x: 10, y: 10 },
      { x: 72, y: 34 },
      { extent: 'finite', constrain: true },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const manager = new OperationManager(document);
    manager.beginTransaction('Create constrained construction line');
    for (const operation of prepared.plan.operations) manager.execute(operation);
    manager.commitTransaction();
    const endNode = document.getNode(prepared.plan.nodeIds[1]);
    const segment = document.getSegment(prepared.plan.segmentId);
    expect(endNode?.position.y).toBeCloseTo(0, 9);
    expect(endNode?.position.x).toBeGreaterThan(0);
    expect(segment?.role === 'construction' && segment.constructionExtent).toBe('finite');
  });

  it('rejects zero-length drags deterministically without allocating a plan', () => {
    const document = VectorDocument.createEmpty();
    const prepared = prepareConstructionLineObject(
      document,
      { x: 42, y: 42 },
      { x: 42, y: 42 },
      { extent: 'infinite' },
    );
    expect(prepared).toEqual({
      ok: false,
      message: 'Construction line requires a non-zero drag.',
    });
  });
});
