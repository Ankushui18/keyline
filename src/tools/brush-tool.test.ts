import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import type { DrawingStyle } from '../core/types';
import { prepareBrushObject } from './brush-tool';

const style: DrawingStyle = {
  strokeEnabled: true,
  strokeColor: '#345678',
  strokeWidth: 10,
  strokeCap: 'round',
  strokeJoin: 'round',
  strokeAlignment: 'center',
  fillEnabled: false,
  fillColor: '#abcdef',
};

describe('Brush tool', () => {
  it('commits one pressure-aware variable-width Typed Graph object and undoes atomically', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = prepareBrushObject(document, [
      { point: { x: 20, y: 30 }, pressure: 0.2 },
      { point: { x: 40, y: 36 }, pressure: 0.45 },
      { point: { x: 64, y: 52 }, pressure: 0.9 },
      { point: { x: 92, y: 46 }, pressure: 0.5 },
      { point: { x: 120, y: 70 }, pressure: 0.25 },
    ], style)!;

    manager.execute({ type: 'BATCH', payload: { label: 'Draw brush path', operations: plan.operations } });
    const object = document.getObject(plan.objectId)!;
    const appearance = document.getAppearance(object.appearanceId)!;
    const segments = plan.segmentIds.map((id) => document.getSegment(id)!);

    expect(object.name).toBe('Brush 1');
    expect(object.transform).toMatchObject({ x: 20, y: 30 });
    expect(appearance.stroke).toMatchObject({ color: '#345678', width: 10, visible: true });
    expect(segments.every((segment) => segment.type === 'bezier' && segment.widthProfile?.length === 2)).toBe(true);
    const widths = segments.flatMap((segment) => segment.widthProfile?.map((point) => point.width) ?? []);
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
    expect(new Set(segments.flatMap((segment) => segment.widthProfile?.map((point) => point.id) ?? [])).size).toBe(widths.length);

    expect(manager.undo()).toBe(true);
    expect(document.getObject(plan.objectId)).toBeUndefined();
    expect(manager.redo()).toBe(true);
    expect(document.getObject(plan.objectId)?.name).toBe('Brush 1');
  });

  it('falls back to stable mouse pressure and rejects tap gestures', () => {
    const document = VectorDocument.createEmpty();
    expect(prepareBrushObject(document, [{ point: { x: 1, y: 2 }, pressure: 0 }], style)).toBeNull();
    const plan = prepareBrushObject(document, [
      { point: { x: 1, y: 2 }, pressure: 0 },
      { point: { x: 30, y: 20 }, pressure: 0 },
      { point: { x: 60, y: 10 }, pressure: 0 },
    ], style)!;
    const addSegments = plan.operations.filter((operation) => operation.type === 'ADD_SEGMENT');
    expect(addSegments.length).toBeGreaterThan(0);
  });
});
