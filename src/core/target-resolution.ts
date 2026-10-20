import type { VectorDocument } from './document';
import {
  groupChainForLayer, isObjectWithinGroup, selectionForTarget, selectionTargetForObject,
  type GroupSelectionTarget,
} from './group-context';
import { INTERACTION_BOUNDS_POLICY, type GeometryBounds } from './object-geometry';
import { cachedObjectBounds } from './bounds-cache';
import { hitTest, hitTestObject } from '../tools/select-tool';
import { hitTestHandle } from '../tools/bend-tool';
import type { EntityId, Point, SelectionState } from './types';

/**
 * One description of "what is under the pointer", shared by hover, press,
 * double-click, cycling and modifier clicks. Hover never builds its own answer:
 * it resolves through the same functions the press uses, so the outline always
 * names the thing a click will select.
 */
export interface PointerTarget {
  /** What a plain click selects: a group layer id, or an object id. */
  selectionId: EntityId;
  /** True when the click selects a whole group rather than one shape. */
  group: boolean;
  /** Every object the click would select. */
  objectIds: EntityId[];
  /** The leaf object under the pointer. Differs from `selectionId` inside a group. */
  objectId: EntityId;
  /** World-space outline for the preview. */
  bounds: GeometryBounds;
  /** Path affordance under the pointer, when it belongs to the resolved object. */
  geometry?: { kind: 'node' | 'segment'; id: EntityId };
  /** Bézier control point under the pointer, only while its node is selected. */
  handle?: { nodeId: EntityId; handleType: 'in' | 'out' };
}

export type PointerTargetKind = 'group' | 'object' | 'node' | 'segment' | 'handle';

export function targetKind(target: PointerTarget): PointerTargetKind {
  if (target.handle) return 'handle';
  if (target.geometry) return target.geometry.kind;
  return target.group ? 'group' : 'object';
}

function unionBounds(document: VectorDocument, objectIds: EntityId[]): GeometryBounds {
  return objectIds.reduce<GeometryBounds>((union, objectId) => {
    const bounds = cachedObjectBounds(document, objectId, INTERACTION_BOUNDS_POLICY);
    if (union.minX === Number.POSITIVE_INFINITY) return { ...bounds };
    const minX = Math.min(union.minX, bounds.minX);
    const minY = Math.min(union.minY, bounds.minY);
    const maxX = Math.max(union.maxX, bounds.maxX);
    const maxY = Math.max(union.maxY, bounds.maxY);
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }, { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY, width: 0, height: 0 });
}

/** Resolves a leaf object into the thing a click selects, with the outline to draw. */
export function resolveObjectTarget(
  document: VectorDocument,
  objectId: EntityId,
  context?: EntityId,
): PointerTarget | undefined {
  const selection = selectionTargetForObject(document, objectId, context);
  if (!selection) return undefined;
  const bounds = unionBounds(document, selection.objectIds);
  if (!Number.isFinite(bounds.minX)) return undefined;
  return {
    selectionId: selection.id,
    group: selection.kind === 'group',
    objectIds: selection.objectIds,
    objectId,
    bounds,
  };
}

export interface PointerQuery {
  /** Pointer position in document space. */
  point: Point;
  /** Pointer position in the edited object's local space, for node and handle hits. */
  localPoint?: Point;
  /** Screen-space tolerance converted into document units by the caller. */
  tolerance: number;
  selection: SelectionState;
}

/**
 * The whole pointer pipeline. Object mode answers with the group-aware selection
 * target; point-editing mode answers with the anchor, segment or handle the pointer
 * is over. Hidden and locked artwork is rejected by the document's ancestor checks,
 * so a descendant of either never becomes a target.
 */
export function resolvePointerTarget(document: VectorDocument, query: PointerQuery): PointerTarget | undefined {
  const { point, tolerance, selection } = query;
  const localPoint = query.localPoint ?? point;

  if (selection.mode === 'network' && selection.editingObjectId) {
    const object = document.getObject(selection.editingObjectId);
    if (!object) return undefined;
    const bounds = cachedObjectBounds(document, object.id, INTERACTION_BOUNDS_POLICY);
    const handle = hitTestHandle(document, selection.nodeIds, localPoint, tolerance);
    if (handle) {
      return {
        selectionId: object.id, group: false, objectIds: [object.id], objectId: object.id, bounds,
        handle: { nodeId: handle.nodeId, handleType: handle.handleType },
      };
    }
    const hit = hitTest(document, point, tolerance, object.id);
    if (!hit) return undefined;
    return {
      selectionId: object.id, group: false, objectIds: [object.id], objectId: object.id, bounds,
      geometry: { kind: hit.kind, id: hit.id },
    };
  }

  const hit = hitTestObject(document, point, tolerance);
  if (!hit) return undefined;
  const entered = selection.groupContext;
  const context = entered && isObjectWithinGroup(document, hit.id, entered) ? entered : undefined;
  // Object mode reports bodies only. Anchors, segments and handles are affordances of
  // point editing; suggesting one here would promise a target the click will not take.
  return resolveObjectTarget(document, hit.id, context);
}

/**
 * The parent-selection gesture: `Alt`-click steps out one level and selects whatever the
 * pointer would resolve to at that level. At the page root there is nothing to step out
 * of, so it answers `undefined` and the click behaves normally.
 *
 * The returned `context` is the level the selection belongs to, which is why selecting a
 * group also leaves it.
 */
export function parentGroupTarget(
  document: VectorDocument,
  objectId: EntityId,
  context?: EntityId,
): (GroupSelectionTarget & { context?: EntityId }) | undefined {
  if (!context) return undefined;
  const outer = groupChainForLayer(document, context)[0];
  const target = selectionTargetForObject(document, objectId, outer);
  if (!target) return undefined;
  return { ...target, context: outer };
}

export interface ObjectPressResult {
  selection: SelectionState;
  /** True when the press descended into a group instead of selecting or editing a leaf. */
  enteredGroup: boolean;
}

/**
 * The single decision a press makes: which selection results, and whether the press
 * descended into a group. `objectId` is the raw hit, not the thing that gets selected.
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
