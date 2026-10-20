/**
 * Direct-manipulation resize for whole objects.
 *
 * A selected object already draws a bounding box, so the box is also where the
 * handles live. The maths stays in the document model: a resize is expressed as
 * an ordinary `UPDATE_OBJECT` transform, which means it undoes, serialises and
 * collaborates like every other edit and never rewrites geometry.
 *
 * What is exact: unrotated objects (any handle), and uniform scaling of rotated
 * objects. What is an approximation: non-uniform scaling of a rotated object,
 * because `rotate × scale` cannot express a world-axis squash — the transform is
 * scaled in the object's own axes and translated so the selection still tracks
 * the pointer. That limit is inherent to the transform model, not to this file.
 */
import type { VectorDocument } from './document';
import { INTERACTION_BOUNDS_POLICY, boundsForPoints, objectBounds, objectBoundsForTransform, type GeometryBounds } from './object-geometry';
import type { OperationInput } from './operations';
import type { EntityId, ObjectTransform, Point } from './types';

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** The eight handles, in the order artboards already use. */
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Smallest span a resize may collapse a selection to, in document units. */
const MIN_SPAN = 0.5;

/** Handle positions for a frame, in world space. Shared by the renderer and hit testing. */
export function resizeHandlePoints(frame: GeometryBounds): Array<{ handle: ResizeHandle; point: Point }> {
  const { minX, minY, maxX, maxY } = frame;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return [
    { handle: 'nw', point: { x: minX, y: minY } },
    { handle: 'n', point: { x: midX, y: minY } },
    { handle: 'ne', point: { x: maxX, y: minY } },
    { handle: 'e', point: { x: maxX, y: midY } },
    { handle: 'se', point: { x: maxX, y: maxY } },
    { handle: 's', point: { x: midX, y: maxY } },
    { handle: 'sw', point: { x: minX, y: maxY } },
    { handle: 'w', point: { x: minX, y: midY } },
  ];
}

/** Union of the interaction bounds of the given objects, or undefined when empty. */
export function selectionFrame(document: VectorDocument, objectIds: Iterable<EntityId>): GeometryBounds | undefined {
  const points: Point[] = [];
  for (const objectId of objectIds) {
    if (!document.getObject(objectId)) continue;
    const bounds = objectBounds(document, objectId, INTERACTION_BOUNDS_POLICY);
    points.push({ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY });
  }
  if (points.length === 0) return undefined;
  return boundsForPoints(points);
}

export interface ResizeTarget {
  objectId: EntityId;
  /** Transform captured when the gesture started; every frame is computed from it. */
  transform: ObjectTransform;
  bounds: GeometryBounds;
}

/** The resizable part of a selection: existing, unlocked objects and their start state. */
export function resizeTargets(document: VectorDocument, objectIds: Iterable<EntityId>): ResizeTarget[] {
  const targets: ResizeTarget[] = [];
  for (const objectId of objectIds) {
    const object = document.getObject(objectId);
    if (!object || document.isObjectLocked(objectId)) continue;
    targets.push({
      objectId,
      transform: { ...object.transform },
      bounds: objectBounds(document, objectId, INTERACTION_BOUNDS_POLICY),
    });
  }
  return targets;
}

export interface ResizePlan {
  handle: ResizeHandle;
  objectIds: EntityId[];
  operations: OperationInput[];
  /** Bounds the selection should have after the plan is applied. */
  bounds: GeometryBounds;
}

export interface ResizeOptions {
  /** `Shift`: keep the selection's aspect ratio on corner handles. */
  proportional?: boolean;
}

function scaleFactor(pointerAlongAxis: number, anchor: number, span: number, towardsPositive: boolean): number {
  if (span <= 1e-9) return 1;
  const raw = towardsPositive ? (pointerAlongAxis - anchor) / span : (anchor - pointerAlongAxis) / span;
  if (!Number.isFinite(raw)) return 1;
  return Math.max(raw, MIN_SPAN / span);
}

/**
 * Builds the resize for one pointer position. `targets` and `frame` must be the
 * values captured at gesture start, so repeated calls never compound.
 */
export function prepareResizeObjects(
  document: VectorDocument,
  targets: ResizeTarget[],
  frame: GeometryBounds,
  handle: ResizeHandle,
  pointer: Point,
  options: ResizeOptions = {},
): ResizePlan | null {
  if (targets.length === 0) return null;
  const movesX = handle.endsWith('e') || handle.endsWith('w');
  const movesY = handle.startsWith('n') || handle.startsWith('s');
  if (!movesX && !movesY) return null;

  const anchorX = handle.endsWith('e') ? frame.minX : frame.maxX;
  const anchorY = handle.startsWith('s') ? frame.minY : frame.maxY;

  let scaleX = movesX
    ? scaleFactor(pointer.x, anchorX, frame.width, handle.endsWith('e'))
    : 1;
  let scaleY = movesY
    ? scaleFactor(pointer.y, anchorY, frame.height, handle.startsWith('s'))
    : 1;
  if (options.proportional && movesX && movesY) {
    // Follow whichever axis the pointer moved most, so the gesture never fights itself.
    const dominant = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
    scaleX = dominant;
    scaleY = dominant;
  }

  const operations: OperationInput[] = [];
  const boundsList: GeometryBounds[] = [];
  for (const target of targets) {
    const candidate: ObjectTransform = {
      ...target.transform,
      scaleX: target.transform.scaleX * scaleX,
      scaleY: target.transform.scaleY * scaleY,
    };
    const candidateBounds = objectBoundsForTransform(document, target.objectId, candidate, INTERACTION_BOUNDS_POLICY);
    // Map the object's own bounds through the same anchor-fixed transform as the
    // selection frame, then translate the scaled object onto that position.
    const expectedMinX = movesX ? anchorX + (target.bounds.minX - anchorX) * scaleX : target.bounds.minX;
    const expectedMinY = movesY ? anchorY + (target.bounds.minY - anchorY) * scaleY : target.bounds.minY;
    const dx = expectedMinX - candidateBounds.minX;
    const dy = expectedMinY - candidateBounds.minY;
    const next: ObjectTransform = { ...candidate, x: candidate.x + dx, y: candidate.y + dy };
    boundsList.push({
      minX: candidateBounds.minX + dx,
      minY: candidateBounds.minY + dy,
      maxX: candidateBounds.maxX + dx,
      maxY: candidateBounds.maxY + dy,
      width: candidateBounds.width,
      height: candidateBounds.height,
    });
    operations.push({
      type: 'UPDATE_OBJECT',
      payload: { objectId: target.objectId, updates: { transform: next } },
    });
  }

  return {
    handle,
    objectIds: targets.map((target) => target.objectId),
    operations,
    bounds: boundsForPoints(boundsList.flatMap((bounds) => [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
    ])),
  };
}

export function resizeCursor(handle: ResizeHandle): string {
  if (handle === 'n' || handle === 's') return 'ns-resize';
  if (handle === 'e' || handle === 'w') return 'ew-resize';
  return handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize';
}
