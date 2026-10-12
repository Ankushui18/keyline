import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Segment, VectorNode, VectorPath } from '../core/types';
import { preparePrimitiveObject } from './primitive-tool';
import { hitTest, hitTestObject } from './select-tool';

function constructionFixture(extent: 'finite' | 'infinite') {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const networkId = document.activeNetwork.id;
  const nodes: VectorNode[] = [
    { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] },
    { id: createEntityId(), position: { x: 10, y: 0 }, constraintIds: [] },
  ];
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
  const segment: Segment = {
    id: createEntityId(),
    startNodeId: nodes[0].id,
    endNodeId: nodes[1].id,
    type: 'line',
    role: 'construction',
    constructionExtent: extent,
  };
  manager.beginTransaction('Construction hit fixture');
  nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId } }));
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { document, manager, nodes, segment, object: document.getObjectForSegment(segment.id)! };
}

describe('construction hit testing', () => {
  it('keeps finite hits clamped to anchors and resolves infinite extension hits', () => {
    const finite = constructionFixture('finite');
    expect(hitTest(finite.document, { x: 5, y: 1 }, 1.1)).toEqual({
      kind: 'segment', id: finite.segment.id,
    });
    expect(hitTest(finite.document, { x: 20, y: 1 }, 1.1)).toBeNull();

    const infinite = constructionFixture('infinite');
    expect(hitTest(infinite.document, { x: 200, y: 1 }, 1.1)).toEqual({
      kind: 'segment', id: infinite.segment.id,
    });
    expect(hitTestObject(infinite.document, { x: -200, y: 1 }, 1.1)).toEqual({
      kind: 'object', id: infinite.object.id,
      geometryHit: { kind: 'segment', id: infinite.segment.id },
    });
  });

  it('resolves an infinite extension on a transformed primitive object', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = preparePrimitiveObject(
      document,
      'line',
      { x: -240, y: -90 },
      { x: -100, y: -90 },
    )!;
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: {
        segments: [{
          segmentId: plan.segmentIds[0],
          role: 'construction',
          constructionExtent: 'infinite',
        }],
      },
    });
    expect(hitTestObject(document, { x: 290, y: -90 }, 2)?.id).toBe(plan.objectId);
  });

  it('uses the object bounds as a forgiving middle hit target in object mode', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const rectangle = preparePrimitiveObject(document, 'rectangle', { x: 20, y: 30 }, { x: 120, y: 90 })!;
    manager.execute({ type: 'BATCH', payload: { label: 'Rectangle fixture', operations: rectangle.operations } });

    const middle = hitTestObject(document, { x: 70, y: 60 }, 2);
    expect(middle).toEqual({ kind: 'object', id: rectangle.objectId });
    expect(middle?.geometryHit).toBeUndefined();
  });

  it('retains node priority over construction-line hits', () => {
    const fixture = constructionFixture('infinite');
    expect(hitTest(fixture.document, { x: 0, y: 0 }, 2)).toEqual({
      kind: 'node', id: fixture.nodes[0].id,
    });
  });

  it('handles rotation and non-uniform object scale in document space', () => {
    const fixture = constructionFixture('infinite');
    fixture.manager.execute({
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: fixture.object.id,
        updates: { transform: { x: 100, y: 50, rotation: 90, scaleX: 2, scaleY: 3 } },
      },
    });
    expect(hitTest(fixture.document, { x: 102, y: 200 }, 2.1)).toEqual({
      kind: 'segment', id: fixture.segment.id,
    });
    expect(hitTest(fixture.document, { x: 104, y: 200 }, 2.1)).toBeNull();
  });

  it('honors editing-object, lock, and visibility filters', () => {
    const fixture = constructionFixture('infinite');
    expect(hitTest(fixture.document, { x: 50, y: 0 }, 1, fixture.object.id)).toEqual({
      kind: 'segment', id: fixture.segment.id,
    });
    expect(hitTest(fixture.document, { x: 50, y: 0 }, 1, 'another-object')).toBeNull();

    const layer = fixture.document.getLayerForObject(fixture.object.id)!;
    fixture.manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { locked: true } } });
    expect(hitTest(fixture.document, { x: 50, y: 0 }, 1)).toBeNull();
    fixture.manager.undo();
    fixture.manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { visible: false } } });
    expect(hitTest(fixture.document, { x: 50, y: 0 }, 1)).toBeNull();
  });
});
