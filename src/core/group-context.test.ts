import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import type { EntityId, LayerNode } from '../core/types';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import {
  exitGroupContext, groupChainForObject, groupToEnterOnDoubleClick, isObjectWithinGroup,
  resolveObjectPress, selectionForTarget, selectionTargetForObject,
} from './group-context';
import { hitTestObject } from '../tools/select-tool';
import { prepareNudgeObjects } from './object-operations';
import { objectBounds } from './object-geometry';

/**
 * Behaviour contract for group navigation.
 *
 * 1. At the page root a click selects the outermost group, never a leaf inside it.
 *    The selection carries every visible descendant object, so move, resize, rotate,
 *    delete and undo keep working through the existing multi-object paths.
 * 2. Inside an entered group a click selects that group's direct child: a nested
 *    group or a leaf object, whichever contains the pointer.
 * 3. Double-click on a group descends exactly one level and selects the next child in.
 *    Repeated double-clicks walk nested groups. Double-click on an ungrouped object
 *    keeps entering point editing, which is unchanged.
 * 4. Escape leaves one level and selects the group just left; with no entered group
 *    it keeps whatever behaviour it had.
 * 5. Clicking anything outside the entered group leaves the group first. A click can
 *    never select a child of a group the user is not inside.
 * 6. Entering a group never changes visibility. It is a selection context, not the
 *    existing layer isolation, which hides everything else.
 * 7. Hidden or locked groups are not reachable through their children: the document
 *    already answers `isObjectLocked` and `isObjectVisible` along the ancestor chain.
 */

interface Scene {
  document: VectorDocument;
  manager: OperationManager;
  /** object ids: `a` sits in the inner group, `b` next to it, `c` outside every group. */
  objects: { a: EntityId; b: EntityId; c: EntityId };
  /** inner group nested in the outer group. */
  inner: EntityId;
  outer: EntityId;
  layers: { a: EntityId; b: EntityId; c: EntityId };
}

function draw(manager: OperationManager, document: VectorDocument, x: number, y: number) {
  const plan = preparePrimitiveObject(document, 'rectangle', { x, y }, { x: x + 40, y: y + 40 })!;
  manager.beginTransaction('Draw fixture rectangle');
  plan.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  return { objectId: plan.objectId, layerId: plan.layerId };
}

/** Groups `layerIds` (in order) under a new group layer, the way the Layers panel does. */
function makeGroup(manager: OperationManager, document: VectorDocument, layerIds: EntityId[], name: string): EntityId {
  const first = document.getLayer(layerIds[0])!;
  const siblings = first.parentId
    ? document.getLayer(first.parentId)!.childIds
    : document.getArtboard(first.artboardId)!.layerIds;
  const group: LayerNode = {
    id: `${name}:${first.artboardId}`, kind: 'group', name, artboardId: first.artboardId,
    parentId: first.parentId, childIds: [], visible: true, locked: false, expanded: true,
  };
  const index = Math.min(...layerIds.map((layerId) => siblings.indexOf(layerId)));
  manager.beginTransaction(`Group into ${name}`);
  manager.execute({ type: 'ADD_LAYER', payload: { layer: group, index } });
  layerIds.forEach((layerId, childIndex) => manager.execute({
    type: 'MOVE_LAYER',
    payload: { layerId, parentId: group.id, artboardId: first.artboardId, index: childIndex },
  }));
  manager.commitTransaction();
  return group.id;
}

function scene(): Scene {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const a = draw(manager, document, 0, 0);
  const b = draw(manager, document, 60, 0);
  const c = draw(manager, document, 120, 0);
  const inner = makeGroup(manager, document, [a.layerId], 'Inner');
  const outer = makeGroup(manager, document, [inner, b.layerId], 'Outer');
  return {
    document, manager,
    objects: { a: a.objectId, b: b.objectId, c: c.objectId },
    layers: { a: a.layerId, b: b.layerId, c: c.layerId },
    inner, outer,
  };
}

const EMPTY_SELECTION = {
  mode: 'object' as const, objectIds: new Set<EntityId>(), nodeIds: new Set<EntityId>(), segmentIds: new Set<EntityId>(),
};

describe('group navigation contract', () => {
  it('reports the group chain of an object, outermost first', () => {
    const { document, objects, inner, outer } = scene();
    expect(groupChainForObject(document, objects.a)).toEqual([outer, inner]);
    expect(groupChainForObject(document, objects.b)).toEqual([outer]);
    expect(groupChainForObject(document, objects.c)).toEqual([]);
  });

  it('selects the outermost group at the page root instead of the leaf', () => {
    const { document, objects, layers, outer } = scene();
    const target = selectionTargetForObject(document, objects.a);
    expect(target).toEqual({ kind: 'group', id: outer, objectIds: expect.arrayContaining([objects.a, objects.b]) });
    expect(target?.objectIds).not.toContain(objects.c);
    // A group selection covers every descendant, so existing transform paths apply to all of them.
    expect(layers.a).toBeTruthy();
    expect(selectionTargetForObject(document, objects.c)).toEqual({ kind: 'object', id: objects.c, objectIds: [objects.c] });
  });

  it('selects the direct child once a group is entered', () => {
    const { document, objects, inner, outer } = scene();
    expect(selectionTargetForObject(document, objects.a, outer)?.id).toBe(inner);
    expect(selectionTargetForObject(document, objects.a, inner)?.id).toBe(objects.a);
    expect(selectionTargetForObject(document, objects.b, outer)?.id).toBe(objects.b);
  });

  it('descends exactly one level per double-click', () => {
    const { document, objects, inner, outer } = scene();
    expect(groupToEnterOnDoubleClick(document, objects.a)).toBe(outer);
    expect(groupToEnterOnDoubleClick(document, objects.a, outer)).toBe(inner);
    expect(groupToEnterOnDoubleClick(document, objects.a, inner)).toBeUndefined();
    // Ungrouped artwork keeps double-clicking into point editing.
    expect(groupToEnterOnDoubleClick(document, objects.c)).toBeUndefined();
  });

  it('leaves one level per Escape and selects the group it left', () => {
    const { document, objects, inner, outer } = scene();
    const fromInner = exitGroupContext(document, inner);
    expect(fromInner.context).toBe(outer);
    expect(fromInner.target).toEqual({ kind: 'group', id: inner, objectIds: [objects.a] });
    const fromOuter = exitGroupContext(document, outer);
    expect(fromOuter.context).toBeUndefined();
    expect(fromOuter.target).toEqual({ kind: 'group', id: outer, objectIds: expect.arrayContaining([objects.a, objects.b]) });
  });

  it('treats a selection outside the entered group as leaving it', () => {
    const { document, objects, outer, inner } = scene();
    expect(isObjectWithinGroup(document, objects.a, outer)).toBe(true);
    expect(isObjectWithinGroup(document, objects.a, inner)).toBe(true);
    expect(isObjectWithinGroup(document, objects.b, inner)).toBe(false);
    expect(isObjectWithinGroup(document, objects.c, outer)).toBe(false);
    // Asking for a target with a context the object is not inside answers for the root,
    // so the caller can drop the context rather than silently editing a hidden child.
    expect(selectionTargetForObject(document, objects.c, outer)?.id).toBe(objects.c);
  });

  it('toggles a whole group with shift-click and keeps the entered context', () => {
    const { document, objects, outer } = scene();
    const group = selectionTargetForObject(document, objects.a)!;
    const leaf = selectionTargetForObject(document, objects.c)!;
    const initial = { mode: 'object' as const, objectIds: new Set([leaf.id]), nodeIds: new Set<EntityId>(), segmentIds: new Set<EntityId>() };
    const added = selectionForTarget(initial, group, true, outer);
    expect(added.objectIds).toEqual(new Set([leaf.id, ...group.objectIds]));
    expect(added.groupContext).toBe(outer);
    const removed = selectionForTarget(added, group, true, outer);
    expect(removed.objectIds).toEqual(new Set([leaf.id]));
    // A click without a modifier replaces the selection and drops a stale context.
    const replaced = selectionForTarget(added, group, false);
    expect(replaced.objectIds).toEqual(new Set(group.objectIds));
    expect(replaced.groupContext).toBeUndefined();
  });

  it('resolves a real press from hit testing through nested groups', () => {
    const { document, objects, outer, inner } = scene();
    const hit = hitTestObject(document, { x: 20, y: 20 }, 2);
    expect(hit?.id).toBe(objects.a);

    const first = resolveObjectPress(document, EMPTY_SELECTION, hit?.id);
    expect(first.enteredGroup).toBe(false);
    expect(first.selection.objectIds).toEqual(new Set([objects.a, objects.b]));

    const intoOuter = resolveObjectPress(document, first.selection, hit?.id, { doubleClick: true });
    expect(intoOuter.enteredGroup).toBe(true);
    expect(intoOuter.selection.groupContext).toBe(outer);
    expect(intoOuter.selection.objectIds).toEqual(new Set([objects.a]));

    const intoInner = resolveObjectPress(document, intoOuter.selection, hit?.id, { doubleClick: true });
    expect(intoInner.selection.groupContext).toBe(inner);
    expect(intoInner.selection.objectIds).toEqual(new Set([objects.a]));

    // Inside the innermost group the object is a leaf: a double-click means point editing.
    const onLeaf = resolveObjectPress(document, intoInner.selection, hit?.id, { doubleClick: true });
    expect(onLeaf.enteredGroup).toBe(false);
    expect(onLeaf.selection.groupContext).toBe(inner);
  });

  it('leaves the entered group when the press lands outside it', () => {
    const { document, objects, outer } = scene();
    const inside = resolveObjectPress(document, EMPTY_SELECTION, objects.a, { doubleClick: true });
    expect(inside.selection.groupContext).toBe(outer);
    const outsideHit = hitTestObject(document, { x: 140, y: 20 }, 2);
    expect(outsideHit?.id).toBe(objects.c);
    const outside = resolveObjectPress(document, inside.selection, outsideHit?.id);
    expect(outside.enteredGroup).toBe(false);
    expect(outside.selection.groupContext).toBeUndefined();
    expect(outside.selection.objectIds).toEqual(new Set([objects.c]));
  });

  it('transforms a whole group through the existing object operations, in one undo step', () => {
    const { document, manager, objects } = scene();
    const group = selectionTargetForObject(document, objects.a)!;
    const before = group.objectIds.map((id) => objectBounds(document, id));
    const plan = prepareNudgeObjects(document, group.objectIds, { x: 10, y: 5 })!;
    manager.beginTransaction('Nudge group');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    group.objectIds.forEach((id, index) => {
      const after = objectBounds(document, id);
      expect(after.minX).toBeCloseTo(before[index].minX + 10);
      expect(after.minY).toBeCloseTo(before[index].minY + 5);
    });
    expect(manager.undo()).toBe(true);
    expect(group.objectIds.map((id) => objectBounds(document, id))).toEqual(before);
  });

  it('never makes a hidden or locked group reachable through its children', () => {
    const { document, manager, objects, outer } = scene();
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: outer, updates: { locked: true } } });
    expect(document.isObjectLocked(objects.a)).toBe(true);
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: outer, updates: { locked: false, visible: false } } });
    expect(document.isObjectVisible(objects.a)).toBe(false);
    // Hidden artwork cannot be hit, so no target is offered at all.
    expect(selectionTargetForObject(document, objects.a)).toBeUndefined();
  });
});
