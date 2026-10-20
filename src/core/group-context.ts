import type { VectorDocument } from './document';
import type { EntityId, SelectionState } from './types';

/**
 * What a click selects: a leaf object, or a group standing in for all of its contents.
 * Group selections carry their visible descendants so every existing multi-object path
 * (move, resize, rotate, delete, undo) keeps working without a group transform node.
 */
export interface GroupSelectionTarget {
  kind: 'object' | 'group';
  id: EntityId;
  objectIds: EntityId[];
}

/** Group layers above a layer, outermost first. */
export function groupChainForLayer(document: VectorDocument, layerId: EntityId): EntityId[] {
  const chain: EntityId[] = [];
  let layer = document.getLayer(layerId);
  while (layer?.parentId) {
    const parent = document.getLayer(layer.parentId);
    if (!parent) break;
    if (parent.kind === 'group') chain.unshift(parent.id);
    layer = parent;
  }
  return chain;
}

/** Group layers that contain the object, outermost first. */
export function groupChainForObject(document: VectorDocument, objectId: EntityId): EntityId[] {
  const layer = document.getLayerForObject(objectId);
  return layer ? groupChainForLayer(document, layer.id) : [];
}

/** Every visible object below a layer, depth first, in paint order. */
export function descendantObjectIds(document: VectorDocument, layerId: EntityId): EntityId[] {
  const result: EntityId[] = [];
  const visit = (id: EntityId) => {
    const layer = document.getLayer(id);
    if (!layer) return;
    if (layer.objectId && document.isObjectVisible(layer.objectId)) result.push(layer.objectId);
    layer.childIds.forEach(visit);
  };
  visit(layerId);
  return result;
}

export function isObjectWithinGroup(document: VectorDocument, objectId: EntityId, groupId: EntityId): boolean {
  return groupChainForObject(document, objectId).includes(groupId);
}

/**
 * The thing a click should select, given the group the user has entered.
 *
 * Outside every group this is the outermost group containing the object, so a click
 * never edits a leaf inside a group the user cannot see is grouped. Inside a group it
 * is that group's direct child — a nested group or a leaf. Hidden and locked artwork
 * offers no target at all: the document already resolves both through the ancestors.
 */
export function selectionTargetForObject(
  document: VectorDocument,
  objectId: EntityId,
  context?: EntityId,
): GroupSelectionTarget | undefined {
  if (!document.getObject(objectId) || !document.isObjectVisible(objectId) || document.isObjectLocked(objectId)) return undefined;
  const chain = groupChainForObject(document, objectId);
  const entered = context ? chain.indexOf(context) : -1;
  // A context the object is not inside is stale: answer for the root, and let the caller
  // drop the context instead of resolving against a group the click did not touch.
  const inner = (entered >= 0 ? chain.slice(entered + 1) : chain)[0];
  if (inner) {
    const objectIds = descendantObjectIds(document, inner);
    return objectIds.length > 0 ? { kind: 'group', id: inner, objectIds } : undefined;
  }
  return { kind: 'object', id: objectId, objectIds: [objectId] };
}

/**
 * The group a double-click descends into, or `undefined` when the target is already a
 * leaf. One call descends one level, so nested groups are walked double-click by
 * double-click. An ungrouped object stays on the existing "enter point editing" path.
 */
export function groupToEnterOnDoubleClick(
  document: VectorDocument,
  objectId: EntityId,
  context?: EntityId,
): EntityId | undefined {
  const target = selectionTargetForObject(document, objectId, context);
  return target?.kind === 'group' ? target.id : undefined;
}

/** One Escape: leave a level and select the group just left. */
export function exitGroupContext(
  document: VectorDocument,
  context: EntityId,
): { context?: EntityId; target?: GroupSelectionTarget } {
  const nextContext = groupChainForLayer(document, context)[0];
  const objectIds = descendantObjectIds(document, context);
  return {
    context: nextContext,
    target: objectIds.length > 0 ? { kind: 'group', id: context, objectIds } : undefined,
  };
}

/**
 * The selection a click produces. Additive clicks toggle the whole target, so
 * shift-clicking a group adds or removes all of its contents in one step.
 */
export function selectionForTarget(
  current: SelectionState,
  target: GroupSelectionTarget | undefined,
  additive: boolean,
  context?: EntityId,
): SelectionState {
  const objectIds = additive ? new Set(current.objectIds) : new Set<EntityId>();
  if (target) {
    const alreadySelected = target.objectIds.every((id) => current.objectIds.has(id));
    target.objectIds.forEach((id) => {
      if (additive && alreadySelected) objectIds.delete(id);
      else objectIds.add(id);
    });
  }
  return context
    ? { mode: 'object', objectIds, nodeIds: new Set(), segmentIds: new Set(), groupContext: context }
    : { mode: 'object', objectIds, nodeIds: new Set(), segmentIds: new Set() };
}

export interface ObjectPressResult {
  selection: SelectionState;
  /** True when the press descended into a group instead of selecting or editing a leaf. */
  enteredGroup: boolean;
}

/**
 * The single decision a press makes in object mode: which selection results, and
 * whether the press descended into a group. `objectId` is the raw hit — the leaf the
 * pointer is over — not the thing that ends up selected.
 */
export function resolveObjectPress(
  document: VectorDocument,
  current: SelectionState,
  objectId: EntityId | undefined,
  { doubleClick = false, additive = false }: { doubleClick?: boolean; additive?: boolean } = {},
): ObjectPressResult {
  const entered = current.groupContext;
  const context = entered && objectId && isObjectWithinGroup(document, objectId, entered) ? entered : undefined;
  const target = objectId ? selectionTargetForObject(document, objectId, context) : undefined;

  if (doubleClick && target?.kind === 'group') {
    const inside = selectionTargetForObject(document, objectId!, target.id);
    return { selection: selectionForTarget(current, inside, false, target.id), enteredGroup: true };
  }

  const alreadySelected = Boolean(target?.objectIds.every((id) => current.objectIds.has(id)));
  if (!additive && alreadySelected) {
    // Clicking inside an existing selection keeps it so the drag moves the whole thing.
    const kept: SelectionState = {
      mode: 'object', objectIds: new Set(current.objectIds), nodeIds: new Set(), segmentIds: new Set(),
    };
    return { selection: context ? { ...kept, groupContext: context } : kept, enteredGroup: false };
  }
  return { selection: selectionForTarget(current, target, additive, context), enteredGroup: false };
}
