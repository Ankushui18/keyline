import type { VectorDocument } from '../core/document';
import {
  constructionLineGeometry,
  projectPointToConstructionLine,
} from '../core/construction-geometry';
import { closestPointOnSegment } from '../core/geometry';
import { parametricInstanceMatrices, parametricSourceObjectId } from '../core/parametric';
import { INTERACTION_BOUNDS_POLICY, objectBounds } from '../core/object-geometry';
import { inverseMatrix, multiplyMatrices, objectTransformMatrix, transformPoint, type Matrix2D } from '../core/transforms';
import type { EntityId, Point, SelectionState } from '../core/types';

export interface HitResult {
  kind: 'node' | 'segment';
  id: EntityId;
}

export interface ObjectHitResult {
  kind: 'object';
  id: EntityId;
  /** Present when the pointer is directly over editable path geometry. */
  geometryHit?: HitResult;
}

export function hitTest(
  document: VectorDocument,
  point: Point,
  tolerance: number,
  objectId?: EntityId,
): HitResult | null {
  const nodes = [...document.nodes.values()];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const object = document.getObjectForNode(node.id);
    if (objectId && object?.id !== objectId) continue;
    if (!document.isNodeVisible(node.id) || document.isNodeLocked(node.id)) continue;
    const matrices = object
      ? hitMatricesForNode(document, object.id, node.id)
      : [];
    const positions = matrices.length > 0
      ? matrices.map((matrix) => transformPoint(node.position, matrix))
      : [node.position];
    if (positions.some((position) => distance(position, point) <= tolerance)) {
      return { kind: 'node', id: node.id };
    }
  }

  return hitTestSegment(document, point, tolerance, objectId);
}

/** Segment-only hit testing for area tools such as Eraser, where nearby nodes
 * must not steal the stroke target. */
export function hitTestSegment(
  document: VectorDocument,
  point: Point,
  tolerance: number,
  objectId?: EntityId,
): HitResult | null {
  const segments = [...document.segments.values()];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const object = document.getObjectForSegment(segment.id);
    if (objectId && object?.id !== objectId) continue;
    if (!document.isSegmentVisible(segment.id) || document.isSegmentLocked(segment.id)) continue;
    if (segment.role === 'construction') {
      const line = constructionLineGeometry(document, segment);
      if (line && projectPointToConstructionLine(line, point).distance <= tolerance) {
        return { kind: 'segment', id: segment.id };
      }
      continue;
    }
    const matrices = object
      ? hitMatricesForSegment(document, object.id, segment.id)
      : [];
    const candidates = matrices.length > 0 ? matrices : [undefined];
    for (const matrix of candidates) {
      const inverse = matrix ? inverseMatrix(matrix) : undefined;
      const localPoint = inverse ? transformPoint(point, inverse) : point;
      const closest = closestPointOnSegment(document, segment, localPoint);
      if (!closest) continue;
      const closestWorld = matrix ? transformPoint(closest.point, matrix) : closest.point;
      if (distance(closestWorld, point) <= tolerance) return { kind: 'segment', id: segment.id };
    }
  }
  return null;
}

/** Every object on the active page in paint order: back to front, exactly as drawn. */
export function objectsInPaintOrder(document: VectorDocument): EntityId[] {
  return document.activePage.artboardIds.flatMap((artboardId) =>
    document.objectsForArtboard(artboardId).map((object) => object.id));
}

/**
 * Every object whose bounds contain the point, topmost first, in paint order.
 * Reordering a layer repaints it, so the stack has to follow layer order rather
 * than insertion order or the topmost click would disagree with the picture.
 */
export function objectsUnderPoint(document: VectorDocument, point: Point, tolerance: number): EntityId[] {
  const painted = objectsInPaintOrder(document);
  const hits: EntityId[] = [];
  for (let index = painted.length - 1; index >= 0; index -= 1) {
    const objectId = painted[index];
    if (!document.isObjectVisible(objectId) || document.isObjectLocked(objectId)) continue;
    const bounds = objectBounds(document, objectId, INTERACTION_BOUNDS_POLICY);
    if (bounds.width <= 1e-6 && bounds.height <= 1e-6) continue;
    if (point.x >= bounds.minX - tolerance && point.x <= bounds.maxX + tolerance &&
        point.y >= bounds.minY - tolerance && point.y <= bounds.maxY + tolerance) {
      hits.push(objectId);
    }
  }
  return hits;
}

/** The next object under the pointer after the current one, wrapping around. */
export function nextObjectUnderPoint(
  document: VectorDocument,
  point: Point,
  tolerance: number,
  selected: Iterable<EntityId>,
): ObjectHitResult | null {
  const stack = objectsUnderPoint(document, point, tolerance);
  if (stack.length === 0) return null;
  const current = [...selected];
  const found = stack.reduce((deepest, objectId, index) => (current.includes(objectId) ? Math.max(deepest, index) : deepest), -1);
  return { kind: 'object', id: stack[(found + 1) % stack.length] };
}

export function hitTestObject(document: VectorDocument, point: Point, tolerance: number): ObjectHitResult | null {
  // Object mode treats the visible selection bounds as the draggable target.
  // This makes hollow, unfilled, and heavily stroked vectors movable from their
  // middle rather than requiring users to reacquire a thin path edge.
  const stack = objectsUnderPoint(document, point, tolerance);
  const topOfStack = stack[0];

  // Infinite construction lines are clickable outside their own bounds, so a raw
  // geometry hit can name an object the bounds stack does not contain. Paint order
  // still decides: a shape above the line wins, the line wins when it is on top.
  const geometryHit = hitTest(document, point, tolerance);
  const geometryOwner = geometryHit
    ? (geometryHit.kind === 'node'
        ? document.getObjectForNode(geometryHit.id)?.id
        : document.getObjectForSegment(geometryHit.id)?.id)
    : undefined;
  if (geometryHit && geometryOwner) {
    const painted = objectsInPaintOrder(document);
    const ownerIndex = painted.lastIndexOf(geometryOwner);
    const topIndex = topOfStack ? painted.lastIndexOf(topOfStack) : -1;
    if (ownerIndex >= topIndex && document.isObjectVisible(geometryOwner) && !document.isObjectLocked(geometryOwner)) {
      return { kind: 'object', id: geometryOwner, geometryHit };
    }
  }

  if (!topOfStack) return null;
  const ownGeometry = hitTest(document, point, tolerance, topOfStack);
  return { kind: 'object', id: topOfStack, geometryHit: ownGeometry ?? undefined };
}

export function selectionForObjectHit(
  current: SelectionState,
  hit: ObjectHitResult | null,
  additive: boolean,
): SelectionState {
  if (!hit) return additive ? cloneSelection(current) : emptySelection('object');
  const objectIds = additive ? new Set(current.objectIds) : new Set<EntityId>();
  if (additive && objectIds.has(hit.id)) objectIds.delete(hit.id);
  else objectIds.add(hit.id);
  return { mode: 'object', objectIds, nodeIds: new Set(), segmentIds: new Set() };
}

export function selectionForHit(
  current: SelectionState,
  hit: HitResult | null,
  additive: boolean,
): SelectionState {
  const base = current.mode === 'network' ? current : emptySelection('network');
  if (!hit) {
    return additive ? cloneSelection(base) : {
      mode: 'network',
      editingObjectId: base.editingObjectId,
      objectIds: base.editingObjectId ? new Set([base.editingObjectId]) : new Set(),
      nodeIds: new Set(),
      segmentIds: new Set(),
    };
  }

  if (hit.kind === 'node') {
    if (!additive && base.nodeIds.has(hit.id) && base.segmentIds.size === 0) return cloneSelection(base);
    const nodeIds = additive ? new Set(base.nodeIds) : new Set<EntityId>();
    if (additive && nodeIds.has(hit.id)) nodeIds.delete(hit.id);
    else nodeIds.add(hit.id);
    return {
      mode: 'network',
      editingObjectId: base.editingObjectId,
      objectIds: new Set(base.objectIds),
      nodeIds,
      segmentIds: new Set(),
    };
  }

  if (!additive && base.segmentIds.has(hit.id) && base.nodeIds.size === 0) return cloneSelection(base);
  const segmentIds = additive ? new Set(base.segmentIds) : new Set<EntityId>();
  if (additive && segmentIds.has(hit.id)) segmentIds.delete(hit.id);
  else segmentIds.add(hit.id);
  return {
    mode: 'network',
    editingObjectId: base.editingObjectId,
    objectIds: new Set(base.objectIds),
    nodeIds: new Set(),
    segmentIds,
  };
}

export const emptySelection = (mode: SelectionState['mode'] = 'object'): SelectionState => ({
  mode,
  objectIds: new Set(),
  nodeIds: new Set(),
  segmentIds: new Set(),
});

export const cloneSelection = (selection: SelectionState): SelectionState => ({
  mode: selection.mode,
  editingObjectId: selection.editingObjectId,
  objectIds: new Set(selection.objectIds),
  nodeIds: new Set(selection.nodeIds),
  segmentIds: new Set(selection.segmentIds),
});

export function enterNetworkEditMode(document: VectorDocument, objectId: EntityId): SelectionState {
  if (!document.getObject(objectId)) return emptySelection();
  return {
    mode: 'network',
    editingObjectId: objectId,
    objectIds: new Set([objectId]),
    nodeIds: new Set(),
    segmentIds: new Set(),
  };
}

export function exitNetworkEditMode(selection: SelectionState): SelectionState {
  const objectId = selection.editingObjectId ?? [...selection.objectIds][0];
  return {
    mode: 'object',
    objectIds: objectId ? new Set([objectId]) : new Set(),
    nodeIds: new Set(),
    segmentIds: new Set(),
  };
}

function hitMatricesForSegment(
  document: VectorDocument,
  objectId: EntityId,
  segmentId: EntityId,
): Matrix2D[] {
  const object = document.getObject(objectId);
  if (!object) return [];
  const base = objectTransformMatrix(object.transform);
  const pathId = document.findPathForSegment(segmentId)?.id;
  const instances = [...document.parametricGroups.values()]
    .filter((group) => parametricSourceObjectId(document, group) === objectId &&
      Boolean(pathId && group.sourcePathIds.includes(pathId)))
    .flatMap((group) => parametricInstanceMatrices(document, group))
    .map((matrix) => multiplyMatrices(base, matrix));
  return [base, ...instances];
}

function hitMatricesForNode(
  document: VectorDocument,
  objectId: EntityId,
  nodeId: EntityId,
): Matrix2D[] {
  const sourcePathIds = new Set(document.connectedSegments(nodeId)
    .map((segment) => document.findPathForSegment(segment.id)?.id)
    .filter((pathId): pathId is EntityId => Boolean(pathId)));
  const object = document.getObject(objectId);
  if (!object) return [];
  const base = objectTransformMatrix(object.transform);
  const instances = [...document.parametricGroups.values()]
    .filter((group) => parametricSourceObjectId(document, group) === objectId &&
      group.sourcePathIds.some((pathId) => sourcePathIds.has(pathId)))
    .flatMap((group) => parametricInstanceMatrices(document, group))
    .map((matrix) => multiplyMatrices(base, matrix));
  return [base, ...instances];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
