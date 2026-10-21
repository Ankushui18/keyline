import { describe, expect, it } from 'vitest';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { prepareCreateIconArtboard } from './artboard-operations';
import { VectorDocument } from './document';
import {
  alignmentUpdates, arrangementUpdates, canAlignObjects, canArrangeObjects, canDistributeObjects,
  editableObjectIds, resizedObjectTransform, verticalDistributionUpdates,
  type InspectorTransformUpdate, type ObjectAlignment,
} from './inspector-layout';
import { objectBounds, objectBoundsForTransform } from './object-geometry';
import { OperationManager } from './operations';

function fixture() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: document.activeArtboardId, updates: { frame: { x: 40, y: 60, width: 400, height: 300 } } } });
  const add = (x: number, y: number, width = 40, height = 20) => {
    const plan = preparePrimitiveObject(document, 'rectangle', { x, y }, { x: x + width, y: y + height })!;
    manager.beginTransaction('Add fixture rectangle');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    return document.getObject(plan.objectId)!;
  };
  const apply = (updates: InspectorTransformUpdate[]) => {
    manager.beginTransaction('Inspector layout');
    updates.forEach(({ objectId, transform }) => manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId, updates: { transform } } }));
    manager.commitTransaction();
  };
  return { document, manager, add, apply };
}

describe('reference Design inspector geometry', () => {
  it.each<[ObjectAlignment, string, number]>([
    ['left', 'minX', 40], ['right', 'maxX', 440], ['center-x', 'centerX', 240],
    ['top', 'minY', 60], ['bottom', 'maxY', 360], ['center-y', 'centerY', 210],
  ])('aligns one object %s to its owning frame and undoes in one step', (alignment, coordinate, target) => {
    const { document, manager, add, apply } = fixture();
    const object = add(90, 100);
    const before = objectBounds(document, object.id);
    apply(alignmentUpdates(document, [object.id], alignment));
    const after = objectBounds(document, object.id);
    const actual = coordinate === 'centerX' ? (after.minX + after.maxX) / 2 : coordinate === 'centerY' ? (after.minY + after.maxY) / 2 : after[coordinate as 'minX' | 'maxX' | 'minY' | 'maxY'];
    expect(actual).toBeCloseTo(target);
    expect(manager.undo()).toBe(true);
    expect(objectBounds(document, object.id)).toEqual(before);
  });

  it('uses the owning frame even when a different frame is active', () => {
    const { document, manager, add, apply } = fixture();
    const object = add(90, 100);
    const other = prepareCreateIconArtboard(document, 24, 24);
    manager.beginTransaction('Other frame');
    other.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    expect(document.activeArtboardId).toBe(other.artboard.id);
    apply(alignmentUpdates(document, [object.id], 'left'));
    expect(objectBounds(document, object.id).minX).toBe(40);
  });

  it('aligns a selection to its combined bounds rather than the frame', () => {
    const { document, add, apply } = fixture();
    const first = add(90, 100);
    const second = add(190, 180, 60, 30);
    apply(alignmentUpdates(document, [first.id, second.id], 'right'));
    expect(objectBounds(document, first.id).maxX).toBe(250);
    expect(objectBounds(document, second.id).maxX).toBe(250);
  });

  it('does not move locked or hidden objects, or fall back to frame alignment for a partly locked selection', () => {
    const { document, manager, add } = fixture();
    const first = add(90, 100);
    const locked = add(190, 180);
    const hidden = add(290, 200);
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: document.getLayerForObject(locked.id)!.id, updates: { locked: true } } });
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: document.getLayerForObject(hidden.id)!.id, updates: { visible: false } } });
    expect(alignmentUpdates(document, [locked.id], 'left')).toEqual([]);
    expect(alignmentUpdates(document, [hidden.id], 'left')).toEqual([]);
    expect(alignmentUpdates(document, [first.id, locked.id], 'left')).toEqual([]);
    expect(arrangementUpdates(document, [first.id, locked.id, hidden.id], 'grid')).toEqual([]);
  });

  it('arranges rows with a real gap and preserves all geometry and one-step undo', () => {
    const { document, manager, add, apply } = fixture();
    const first = add(90, 100);
    const second = add(190, 180, 60, 30);
    const third = add(290, 250, 20, 40);
    const ids = [first.id, second.id, third.id];
    const before = ids.map((id) => objectBounds(document, id));
    const nodes = [...document.nodes.values()].map((node) => structuredClone(node));
    apply(arrangementUpdates(document, ids, 'horizontal', 8));
    const after = ids.map((id) => objectBounds(document, id));
    expect(after.map((bounds) => bounds.minY)).toEqual([100, 100, 100]);
    expect(after[1].minX - after[0].maxX).toBe(8);
    expect(after[2].minX - after[1].maxX).toBe(8);
    expect([...document.nodes.values()]).toEqual(nodes);
    manager.undo();
    expect(ids.map((id) => objectBounds(document, id))).toEqual(before);
  });

  it('arranges a grid without overlapping unequal-size objects', () => {
    const { document, add, apply } = fixture();
    const objects = [add(90, 100, 40, 20), add(190, 180, 60, 30), add(290, 250, 20, 40)];
    apply(arrangementUpdates(document, objects.map(({ id }) => id), 'grid', 8));
    const [first, second, third] = objects.map(({ id }) => objectBounds(document, id));
    expect(first.minY).toBe(second.minY);
    expect(second.minX - first.maxX).toBeGreaterThanOrEqual(8);
    expect(third.minX).toBe(first.minX);
    expect(third.minY - Math.max(first.maxY, second.maxY)).toBeGreaterThanOrEqual(8);
  });

  it('distributes equal vertical gaps and leaves the first and last in place', () => {
    const { document, add, apply } = fixture();
    const objects = [add(90, 100, 40, 20), add(190, 180, 60, 30), add(290, 250, 20, 40)];
    const ids = objects.map(({ id }) => id);
    apply(verticalDistributionUpdates(document, ids));
    const [first, second, third] = ids.map((id) => objectBounds(document, id));
    expect(first.minY).toBe(100);
    expect(third.maxY).toBe(290);
    expect(second.minY - first.maxY).toBeCloseTo(third.minY - second.maxY);
  });

  it('reports availability from the same set the commands act on', () => {
    const { document, manager, add } = fixture();
    const first = add(90, 100);
    const second = add(190, 180);
    const third = add(290, 250);
    expect(canAlignObjects(document, [first.id])).toBe(true);
    expect(canAlignObjects(document, [first.id, second.id])).toBe(true);
    expect(canAlignObjects(document, [])).toBe(false);
    expect(canDistributeObjects(document, [first.id, second.id])).toBe(false);
    expect(canDistributeObjects(document, [first.id, second.id, third.id])).toBe(true);
    expect(canArrangeObjects(document, [first.id, second.id])).toBe(true);
    expect(canArrangeObjects(document, [first.id, first.id])).toBe(false);
    expect(editableObjectIds(document, [first.id, second.id])).toEqual([first.id, second.id]);
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: document.getLayerForObject(second.id)!.id, updates: { locked: true } } });
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: document.getLayerForObject(third.id)!.id, updates: { visible: false } } });
    expect(editableObjectIds(document, [first.id, second.id, third.id])).toEqual([first.id]);
    // One editable object among several cannot fall back to the frame, so alignment is not offered.
    expect(canAlignObjects(document, [first.id, second.id])).toBe(false);
    expect(canDistributeObjects(document, [first.id, second.id, third.id])).toBe(false);
    expect(canArrangeObjects(document, [first.id, second.id])).toBe(false);
  });

  it('does not offer alignment for artwork that lives outside every frame', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: document.activeArtboardId, updates: { frame: { x: 0, y: 0, width: 20, height: 20 } } } });
    const plan = preparePrimitiveObject(document, 'rectangle', { x: 200, y: 200 }, { x: 240, y: 240 })!;
    manager.beginTransaction('Artwork on the canvas root');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    const layer = document.getLayerForObject(plan.objectId)!;
    expect(document.getArtboard(layer.artboardId)?.isCanvasRoot).toBe(true);
    expect(canAlignObjects(document, [plan.objectId])).toBe(false);
    expect(alignmentUpdates(document, [plan.objectId], 'left')).toEqual([]);
  });

  it('skips distribution transforms that would not move anything', () => {
    const { document, add } = fixture();
    // Already evenly spaced: 100..140, 174..214, 248..288 with equal 34 gaps.
    const objects = [add(90, 100, 40, 40), add(190, 174, 40, 40), add(290, 248, 40, 40)];
    expect(verticalDistributionUpdates(document, objects.map(({ id }) => id))).toEqual([]);
    expect(canDistributeObjects(document, objects.map(({ id }) => id))).toBe(true);
  });

  it('resizes with and without the ratio lock while preserving visual position', () => {
    const { document, add } = fixture();
    const object = add(90, 100, 40, 20);
    const unlocked = objectBoundsForTransform(document, object.id, resizedObjectTransform(document, object, 'width', 80, false));
    expect(unlocked).toMatchObject({ minX: 90, minY: 100, width: 80, height: 20 });
    const locked = objectBoundsForTransform(document, object.id, resizedObjectTransform(document, object, 'width', 80, true));
    expect(locked).toMatchObject({ minX: 90, minY: 100, width: 80, height: 40 });
  });

  it('resizes quarter-turned and flipped objects on the correct local axis', () => {
    const { document, manager, add } = fixture();
    const original = add(90, 100, 40, 20);
    manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId: original.id, updates: { transform: { ...original.transform, rotation: 90, scaleY: -1 } } } });
    const object = document.getObject(original.id)!;
    const before = objectBounds(document, object.id);
    const transform = resizedObjectTransform(document, object, 'width', before.width * 2, false);
    const after = objectBoundsForTransform(document, object.id, transform);
    expect(transform.scaleY).toBe(-2);
    expect(after.width).toBeCloseTo(before.width * 2);
    expect(after.height).toBeCloseTo(before.height);
    expect(after.minX).toBeCloseTo(before.minX);
    expect(after.minY).toBeCloseTo(before.minY);
  });

  it('ignores invalid sizes and safely handles empty or duplicate IDs', () => {
    const { document, add } = fixture();
    const object = add(90, 100);
    expect(resizedObjectTransform(document, object, 'width', NaN, true)).toEqual(object.transform);
    expect(resizedObjectTransform(document, object, 'height', -1, false)).toEqual(object.transform);
    expect(alignmentUpdates(document, [], 'left')).toEqual([]);
    expect(arrangementUpdates(document, [object.id, object.id], 'horizontal')).toEqual([]);
    expect(verticalDistributionUpdates(document, [object.id])).toEqual([]);
  });
});
