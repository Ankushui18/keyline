import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import {
  cloneFill, cloneFills, defaultLinearGradient, defaultRadialGradient, fillColor, fillPreviewStyle,
  gradientColorAt, isGradientFill, linearGradientAngle, normalizeStops, objectLocalBounds,
  rotateLinearGradient, transformedGradientPoints,
} from './fills';
import type { EntityId, LinearGradientFill, RadialGradientFill } from './types';
import { OperationManager } from './operations';
import { DEFAULT_DRAWING_STYLE } from './drawing-style';
import { preparePrimitiveObject } from '../tools/primitive-tool';

function rectangle(size = 100) {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const plan = preparePrimitiveObject(
    document, 'rectangle', { x: 0, y: 0 }, { x: size, y: size }, { style: DEFAULT_DRAWING_STYLE },
  )!;
  manager.beginTransaction('Fixture');
  plan.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  return { document, manager, objectId: plan.objectId as EntityId };
}

const linear = (overrides: Partial<LinearGradientFill> = {}): LinearGradientFill => ({
  type: 'linear',
  start: { x: 0, y: 0 },
  end: { x: 100, y: 0 },
  stops: [
    { offset: 0, color: '#ff0000', opacity: 1 },
    { offset: 1, color: '#0000ff', opacity: 1 },
  ],
  opacity: 1,
  visible: true,
  ...overrides,
});

describe('gradient stops', () => {
  it('sorts, clamps and pads whatever a caller hands it', () => {
    expect(normalizeStops([
      { offset: 1.4, color: '#ffffff', opacity: 2 },
      { offset: -0.2, color: '', opacity: -1 },
    ])).toEqual([
      { offset: 0, color: '#000000', opacity: 0 },
      { offset: 1, color: '#ffffff', opacity: 1 },
    ]);
  });

  it('keeps at least two stops so neither renderer nor exporter sees a degenerate gradient', () => {
    const padded = normalizeStops([{ offset: 0.25, color: '#123456', opacity: 1 }]);
    expect(padded).toHaveLength(2);
    expect(padded[1]).toEqual({ offset: 1, color: '#123456', opacity: 1 });
    expect(normalizeStops([])).toHaveLength(2);
    expect(normalizeStops(undefined)).toHaveLength(2);
  });

  it('reports the first stop as the single ink of a gradient', () => {
    expect(fillColor({ type: 'solid', color: '#abcdef', opacity: 1, visible: true })).toBe('#abcdef');
    expect(fillColor(linear({ stops: [{ offset: 0, color: '#0a0b0c', opacity: 1 }, { offset: 1, color: '#fff', opacity: 1 }] })))
      .toBe('#0a0b0c');
  });

  it('interpolates the colour at a position, including past the ends', () => {
    expect(gradientColorAt(linear(), 0)).toBe('#ff0000');
    expect(gradientColorAt(linear(), 0.5)).toBe('#800080');
    expect(gradientColorAt(linear(), 1)).toBe('#0000ff');
    expect(gradientColorAt(linear(), 4)).toBe('#0000ff');
  });
});

describe('cloning', () => {
  it('gives a copy its own stops and points, so editing one fill cannot move another', () => {
    const original = linear({ stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }] });
    const copy = cloneFill(original) as LinearGradientFill;
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(copy.stops).not.toBe(original.stops);
    expect(copy.start).not.toBe(original.start);
    copy.stops[0].color = '#00ff00';
    copy.start.x = 40;
    expect(original.stops[0].color).toBe('#ff0000');
    expect(original.start.x).toBe(0);
  });

  it('normalizes while cloning, which is the only write path into the document', () => {
    const messy = linear({ stops: [{ offset: 0.9, color: '#111111', opacity: 1 }, { offset: 0.1, color: '#222222', opacity: 1 }] });
    expect((cloneFill(messy) as LinearGradientFill).stops.map((stop) => stop.offset)).toEqual([0.1, 0.9]);
    expect(cloneFills([messy, { type: 'solid', color: '#fff', opacity: 1, visible: true }])).toHaveLength(2);
  });

  it('keeps the invariant when an appearance is written through an operation', () => {
    const { document, manager, objectId } = rectangle();
    const appearance = document.getAppearance(document.getObject(objectId)!.appearanceId)!;
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: {
        appearanceId: appearance.id,
        updates: { fills: [linear({ stops: [{ offset: 1.2, color: '#abcdef', opacity: 1 }] })] },
      },
    });
    const stored = document.getAppearance(appearance.id)!.fills[0];
    expect(isGradientFill(stored)).toBe(true);
    expect(stored.type === 'linear' ? stored.stops : []).toEqual([
      { offset: 0, color: '#abcdef', opacity: 1 },
      { offset: 1, color: '#abcdef', opacity: 1 },
    ]);
  });
});

describe('persistence', () => {
  it('survives a save and reload through the document snapshot', () => {
    const { document, manager, objectId } = rectangle();
    const appearance = document.getAppearance(document.getObject(objectId)!.appearanceId)!;
    manager.beginTransaction('Gradient fill');
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: { appearanceId: appearance.id, updates: { fills: [linear({ stops: linear().stops })] } },
    });
    manager.commitTransaction();
    const snapshot = JSON.parse(JSON.stringify(document.toSnapshot()));
    const reopened = new VectorDocument(snapshot);
    const stored = reopened.getObject(objectId) ? reopened.getAppearance(reopened.getObject(objectId)!.appearanceId) : undefined;
    const fill = stored?.fills[0];
    expect(fill).toEqual(linear());
    expect(fill?.type === 'linear' ? fill.stops : undefined).not.toBe(linear().stops);
  });
});

describe('gradient geometry', () => {
  it('measures the object box from its anchors', () => {
    const { document, objectId } = rectangle(120);
    const bounds = objectLocalBounds(document, objectId)!;
    expect(bounds.width).toBeCloseTo(120, 6);
    expect(bounds.height).toBeCloseTo(120, 6);
    expect(objectLocalBounds(document, 'missing' as EntityId)).toBeUndefined();
  });

  it('seeds a linear gradient across the shape at the requested angle', () => {
    const { document, objectId } = rectangle(100);
    const across = defaultLinearGradient(document, objectId, 0);
    expect(across.start.y).toBeCloseTo(across.end.y, 6);
    expect(across.start.x).toBeLessThan(across.end.x);
    const down = defaultLinearGradient(document, objectId, 90);
    expect(down.start.x).toBeCloseTo(down.end.x, 6);
    expect(down.start.y).toBeLessThan(down.end.y);
    expect(linearGradientAngle(down)).toBe(90);
  });

  it('rotates without changing where the gradient is centred or how long it is', () => {
    const { document, objectId } = rectangle(100);
    const seeded = defaultLinearGradient(document, objectId, 0);
    const rotated = rotateLinearGradient(seeded, 90);
    expect(linearGradientAngle(rotated)).toBe(90);
    expect((rotated.start.x + rotated.end.x) / 2).toBeCloseTo((seeded.start.x + seeded.end.x) / 2, 6);
    expect((rotated.start.y + rotated.end.y) / 2).toBeCloseTo((seeded.start.y + seeded.end.y) / 2, 6);
    expect(Math.hypot(rotated.end.x - rotated.start.x, rotated.end.y - rotated.start.y))
      .toBeCloseTo(Math.hypot(seeded.end.x - seeded.start.x, seeded.end.y - seeded.start.y), 6);
  });

  it('seeds a radial gradient that covers the shape from its centre', () => {
    const { document, objectId } = rectangle(80);
    const radial: RadialGradientFill = defaultRadialGradient(document, objectId);
    expect(radial.center).toEqual({ x: 40, y: 40 });
    expect(radial.radius).toBeCloseTo(Math.hypot(80, 80) / 2, 6);
  });

  it('moves gradient endpoints with the shape on export', () => {
    const points = transformedGradientPoints(linear(), { a: 2, b: 0, c: 0, d: 2, e: 10, f: 5 });
    expect(points.start).toEqual({ x: 10, y: 5 });
    expect(points.end).toEqual({ x: 210, y: 5 });
    const radial = transformedGradientPoints(
      { type: 'radial', center: { x: 0, y: 0 }, radius: 10, stops: linear().stops, opacity: 1, visible: true },
      { a: 3, b: 0, c: 0, d: 3, e: 0, f: 0 },
    );
    expect(radial.center).toEqual({ x: 0, y: 0 });
    expect(radial.radius).toBeCloseTo(30, 6);
  });
});

describe('gradient preview', () => {
  it('describes the fill in the same CSS the inspector swatch uses', () => {
    expect(fillPreviewStyle({ type: 'solid', color: '#123456', opacity: 1, visible: true })).toBe('#123456');
    expect(fillPreviewStyle(linear({ opacity: 1 }))).toBe(
      'linear-gradient(0deg, #ff0000 0%, #0000ff 100%)',
    );
    const translucent = linear({
      stops: [{ offset: 0, color: '#ff0000', opacity: 0.5 }, { offset: 1, color: '#0000ff', opacity: 1 }],
    });
    expect(fillPreviewStyle(translucent)).toContain('rgba(255, 0, 0, 0.5) 0%');
    expect(fillPreviewStyle({ type: 'radial', center: { x: 0, y: 0 }, radius: 10, stops: linear().stops, opacity: 1, visible: true }))
      .toContain('radial-gradient(circle at 50% 50%');
  });
});
