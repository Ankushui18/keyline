import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import { preparePencilObject } from './pencil-tool';

const style = {
  strokeEnabled: true,
  strokeColor: '#123456',
  strokeWidth: 4,
  strokeCap: 'round' as const,
  strokeJoin: 'round' as const,
  strokeAlignment: 'center' as const,
  fillEnabled: false,
  fillColor: '#abcdef',
};

describe('Pencil tool', () => {
  it('creates one smoothed standalone vector object from a freehand gesture', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = preparePencilObject(document, [
      { x: 20, y: 30 },
      { x: 30, y: 34 },
      { x: 44, y: 50 },
      { x: 60, y: 46 },
      { x: 80, y: 70 },
    ], style)!;

    manager.execute({ type: 'BATCH', payload: { label: 'Draw pencil path', operations: plan.operations } });
    const object = document.getObject(plan.objectId)!;
    const appearance = document.getAppearance(object.appearanceId)!;
    const path = document.getPath(plan.pathId)!;

    expect(object.name).toBe('Pencil 1');
    expect(object.transform).toMatchObject({ x: 20, y: 30 });
    expect(appearance.stroke).toMatchObject({ color: '#123456', width: 4, cap: 'round', join: 'round' });
    expect(appearance.fills).toEqual([]);
    expect(path.isClosed).toBe(false);
    expect(path.segmentIds.length).toBeGreaterThan(0);
    expect(path.segmentIds.every((id) => document.getSegment(id)?.type === 'bezier')).toBe(true);
    expect(plan.nodeIds.some((id) => Boolean(document.getNode(id)?.handleOut))).toBe(true);

    manager.undo();
    expect(document.getObject(plan.objectId)).toBeUndefined();
    manager.redo();
    expect(document.getObject(plan.objectId)).toBeDefined();
  });

  it('ignores tap-sized gestures', () => {
    const document = VectorDocument.createEmpty();
    expect(preparePencilObject(document, [{ x: 10, y: 10 }], style)).toBeNull();
  });
});
