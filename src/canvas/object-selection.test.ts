import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { enterNetworkEditMode } from '../tools/select-tool';
import { networkPathSkeletonSegmentIds, straightLineSelectionPoints } from './renderer';

function commitPrimitive(
  manager: OperationManager,
  kind: Parameters<typeof preparePrimitiveObject>[1],
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const plan = preparePrimitiveObject(manager.document, kind, start, end)!;
  manager.beginTransaction(`Create ${kind}`);
  for (const operation of plan.operations) manager.execute(operation);
  manager.commitTransaction();
  return plan;
}

describe('straight-line object selection', () => {
  it('uses the transformed path centerline instead of an axis-aligned box', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const line = commitPrimitive(manager, 'line', { x: 10, y: 20 }, { x: 70, y: 100 });

    expect(straightLineSelectionPoints(document, line.objectId)).toEqual({
      start: { x: 10, y: 20 },
      end: { x: 70, y: 100 },
    });
  });

  it('keeps bounding-box selection for area shapes', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const rectangle = commitPrimitive(manager, 'rectangle', { x: 10, y: 20 }, { x: 70, y: 100 });

    expect(straightLineSelectionPoints(document, rectangle.objectId)).toBeNull();
  });

  it('shows the complete neutral path skeleton in edit mode without covering selected segments', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const edited = commitPrimitive(manager, 'line', { x: 10, y: 20 }, { x: 70, y: 100 });
    const other = commitPrimitive(manager, 'line', { x: 120, y: 20 }, { x: 180, y: 100 });
    const selection = enterNetworkEditMode(document, edited.objectId);

    expect(networkPathSkeletonSegmentIds(document, selection)).toEqual(edited.segmentIds);
    selection.segmentIds.add(edited.segmentIds[0]);
    expect(networkPathSkeletonSegmentIds(document, selection)).toEqual([]);
    expect(networkPathSkeletonSegmentIds(document, {
      ...selection,
      mode: 'object',
      objectIds: new Set([other.objectId]),
      segmentIds: new Set(),
    })).toEqual([]);
  });
});
