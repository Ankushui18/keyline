import { describe, expect, it } from 'vitest';
import { concreteDocumentSegments } from '../export/svg-export';
import { prepareConstructionLineObject } from '../tools/construction-tool';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { createVectorClipboardPayload, preparePasteObjects } from './clipboard';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { OperationManager } from './operations';
import { ARTWORK_BOUNDS_POLICY, objectBounds } from './object-geometry';
import { prepareDeleteObject } from './object-operations';
import { parametricInstanceMatrices, resolveParametricTransform } from './parametric';
import { transformPoint } from './transforms';
import { hitTest } from '../tools/select-tool';
import type { ParametricGroup } from './types';

function executePlan(manager: OperationManager, operations: Parameters<OperationManager['execute']>[0][]): void {
  manager.beginTransaction('Fixture');
  operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
}

function fixture() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const source = preparePrimitiveObject(document, 'rectangle', { x: 0, y: 0 }, { x: 40, y: 20 })!;
  executePlan(manager, source.operations);
  const guidePreparation = prepareConstructionLineObject(
    document, { x: 100, y: -20 }, { x: 100, y: 80 }, { extent: 'infinite' },
  );
  if (!guidePreparation.ok) throw new Error(guidePreparation.message);
  executePlan(manager, guidePreparation.plan.operations);
  return { document, manager, source, guide: guidePreparation.plan };
}

describe('Gate D parametric construction references', () => {
  it('resolves a live mirror axis from a stable construction segment ID', () => {
    const { document, manager, source, guide } = fixture();
    const group: ParametricGroup = {
      id: createEntityId(),
      sourcePathIds: [source.pathId],
      transform: {
        type: 'mirror', axis: 'y', origin: { x: 20, y: 10 }, angle: 90,
        axisSegmentId: guide.segmentId,
      },
    };
    manager.execute({ type: 'ADD_PARAMETRIC_GROUP', payload: { group } });

    const resolved = resolveParametricTransform(document, group);
    expect(resolved).toMatchObject({ type: 'mirror', origin: { x: 100, y: 30 }, referenced: true });
    if (!resolved || resolved.type !== 'mirror') throw new Error('Expected mirror transform.');
    expect(resolved.angle).toBeCloseTo(Math.PI / 2, 8);
    const before = transformPoint({ x: 0, y: 0 }, parametricInstanceMatrices(document, group)[0]);
    expect(before.x).toBeCloseTo(200, 8);
    expect(before.y).toBeCloseTo(0, 8);
    expect(objectBounds(document, source.objectId, ARTWORK_BOUNDS_POLICY).maxX).toBeCloseTo(200, 8);
    expect(hitTest(document, { x: 180, y: 0 }, 0.5, source.objectId)).toEqual({
      kind: 'segment', id: source.segmentIds[0],
    });
    expect(hitTest(document, { x: 200, y: 0 }, 0.5, source.objectId)).toEqual({
      kind: 'node', id: source.nodeIds[0],
    });

    manager.execute({
      type: 'MOVE_NODE',
      payload: { nodeId: guide.nodeIds[1], delta: { x: 50, y: 0 } },
    });
    const afterMatrix = parametricInstanceMatrices(document, document.parametricGroups.get(group.id)!)[0];
    const after = transformPoint({ x: 0, y: 0 }, afterMatrix);
    expect(after.x).not.toBeCloseTo(before.x, 4);
    expect(after.y).not.toBeCloseTo(before.y, 4);
    expect(document.parametricGroups.get(group.id)?.transform).toMatchObject({ axisSegmentId: guide.segmentId });

    const concrete = concreteDocumentSegments(document)
      .filter((item) => item.segment.id === source.segmentIds[0]);
    expect(concrete).toHaveLength(2);
    expect(concrete.every((item) => Number.isFinite(item.start.x) && Number.isFinite(item.start.y))).toBe(true);
    const guideStart = document.getNode(guide.nodeIds[0])!;
    expect(() => manager.execute({
      type: 'SET_NODE_POSITIONS',
      payload: { positions: [
        { nodeId: guide.nodeIds[0], position: guideStart.position },
        { nodeId: guide.nodeIds[1], position: guideStart.position },
      ] },
    })).toThrow('non-degenerate');

    const restored = new VectorDocument(document.toSnapshot());
    expect(restored.parametricGroups.get(group.id)?.transform).toMatchObject({ axisSegmentId: guide.segmentId });
    expect(parametricInstanceMatrices(restored, restored.parametricGroups.get(group.id)!)[0]).toEqual(afterMatrix);
  });

  it('resolves a radial center from a live construction anchor', () => {
    const { document, manager, source, guide } = fixture();
    const group: ParametricGroup = {
      id: createEntityId(),
      sourcePathIds: [source.pathId],
      transform: {
        type: 'radial', center: { x: 20, y: 10 }, centerNodeId: guide.nodeIds[0],
        count: 4, sweepAngle: 360, startAngle: 15, clockwise: false,
      },
    };
    manager.execute({ type: 'ADD_PARAMETRIC_GROUP', payload: { group } });
    expect(resolveParametricTransform(document, group)).toMatchObject({
      type: 'radial', center: { x: 100, y: -20 }, count: 4, startAngle: 15,
      clockwise: false, referenced: true,
    });
    const before = parametricInstanceMatrices(document, group)[0];
    manager.execute({ type: 'MOVE_NODE', payload: { nodeId: guide.nodeIds[0], delta: { x: -20, y: 12 } } });
    expect(parametricInstanceMatrices(document, document.parametricGroups.get(group.id)!)[0]).not.toEqual(before);
  });

  it('rejects broken and non-construction references without committing a group', () => {
    const { document, manager, source } = fixture();
    expect(() => manager.execute({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: { group: {
        id: createEntityId(), sourcePathIds: [source.pathId],
        transform: { type: 'mirror', axis: 'x', origin: { x: 0, y: 0 }, axisSegmentId: 'missing' },
      } },
    })).toThrow('Mirror reference missing is broken.');
    expect(() => manager.execute({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: { group: {
        id: createEntityId(), sourcePathIds: [source.pathId],
        transform: { type: 'mirror', axis: 'x', origin: { x: 0, y: 0 }, axisSegmentId: source.segmentIds[0] },
      } },
    })).toThrow('Mirror reference must be a straight construction segment.');
    expect(document.parametricGroups.size).toBe(0);

    const valid: ParametricGroup = {
      id: createEntityId(), sourcePathIds: [source.pathId],
      transform: { type: 'mirror', axis: 'x', origin: { x: 0, y: 0 } },
    };
    manager.execute({ type: 'ADD_PARAMETRIC_GROUP', payload: { group: valid } });
    const other = preparePrimitiveObject(document, 'rectangle', { x: 80, y: 0 }, { x: 120, y: 30 })!;
    executePlan(manager, other.operations);
    expect(() => manager.execute({
      type: 'UPDATE_PARAMETRIC_GROUP',
      payload: { groupId: valid.id, updates: { sourcePathIds: [source.pathId, other.pathId] } },
    })).toThrow('one compatible network');
    expect(document.parametricGroups.get(valid.id)?.sourcePathIds).toEqual([source.pathId]);
  });

  it('remaps copied construction references and source paths together', () => {
    const { document, manager, source, guide } = fixture();
    const group: ParametricGroup = {
      id: createEntityId(), sourcePathIds: [source.pathId],
      transform: {
        type: 'mirror', axis: 'y', origin: { x: 20, y: 10 }, axisSegmentId: guide.segmentId,
      },
    };
    manager.execute({ type: 'ADD_PARAMETRIC_GROUP', payload: { group } });
    const payload = createVectorClipboardPayload(document, [source.objectId, guide.objectId])!;
    expect(payload.parametricGroups).toHaveLength(1);
    const paste = preparePasteObjects(document, payload, { offset: { x: 20, y: 20 } })!;
    manager.beginTransaction('Paste referenced group');
    paste.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();

    const pasted = [...document.parametricGroups.values()].find((candidate) => candidate.id !== group.id)!;
    expect(pasted.sourcePathIds[0]).not.toBe(source.pathId);
    expect(pasted.transform).toMatchObject({ type: 'mirror' });
    if (pasted.transform.type !== 'mirror') throw new Error('Expected mirror transform.');
    expect(pasted.transform.axisSegmentId).not.toBe(guide.segmentId);
    expect(document.getSegment(pasted.transform.axisSegmentId!)).toMatchObject({ role: 'construction' });
    expect(parametricInstanceMatrices(document, pasted)).toHaveLength(1);
  });

  it('prevents dangling direct references and removes dependent groups during object deletion', () => {
    const { document, manager, source, guide } = fixture();
    const group: ParametricGroup = {
      id: createEntityId(), sourcePathIds: [source.pathId],
      transform: {
        type: 'mirror', axis: 'y', origin: { x: 20, y: 10 }, axisSegmentId: guide.segmentId,
      },
    };
    manager.execute({ type: 'ADD_PARAMETRIC_GROUP', payload: { group } });
    const segment = document.getSegment(guide.segmentId)!;
    expect(() => manager.execute({
      type: 'REMOVE_SEGMENT', payload: { segment, pathId: guide.pathId },
    })).toThrow('retarget or remove its Parametric Group first');
    expect(document.getSegment(guide.segmentId)).toBeDefined();

    const deletion = prepareDeleteObject(document, guide.objectId)!;
    manager.beginTransaction('Delete referenced guide');
    deletion.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    expect(document.parametricGroups.has(group.id)).toBe(false);
    expect(document.getObject(guide.objectId)).toBeUndefined();
    manager.undo();
    expect(document.parametricGroups.get(group.id)?.transform).toMatchObject({ axisSegmentId: guide.segmentId });
  });
});
