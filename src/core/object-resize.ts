/**
 * Direct-manipulation transforms for whole objects: the selection frame, resizing
 * from its handles and rotating around its centre.
 *
 * The frame is a quad, not an axis-aligned box. For a single selected object the
 * quad is the object's own local bounds carried through its transform, so the
 * handles sit on the shape and rotate with it. Several objects share an
 * axis-aligned quad, because they have no common axis of their own.
 *
 * Both gestures commit ordinary `UPDATE_OBJECT` transforms inside one transaction,
 * so they undo, serialise and collaborate exactly like a pointer drag, and no
 * geometry is ever rewritten: a native arc stays an arc after a 37° rotation.
 *
 * Exactness: resizing and rotating a single object are exact at any angle, because
 * the work happens in that object's own axes. For a multi-selection of rotated
 * objects, non-uniform resizing scales each object in its own axes and positions
 * it from the union frame, which is the usual approximation for editors whose
 * transform is `rotate × scale` rather than a general matrix.
 */
import type { VectorDocument } from './document';
import {
  INTERACTION_BOUNDS_POLICY,
  boundsForPoints,
  objectBoundsForTransform,
  type GeometryBounds,
} from './object-geometry';
import { objectTransformMatrix, rotationMatrix, transformPoint } from './transforms';
import type { OperationInput } from './operations';
import type { EntityId, ObjectTransform, Point } from './types';

/** Pixels outside a corner where the pointer becomes a rotate control. */
const ROTATE_ZONE = 16;

/** Half-size of the square that grabs a resize handle, in pixels. */
const HANDLE_TOLERANCE = 8;

/** Smallest span a resize may collapse a selection to, in document units. */
const MIN_SPAN = 0.5;

/** Rotation step used while `Shift` is held. */
export const ROTATION_SNAP = 15;

const IDENTITY_TRANSFORM: ObjectTransform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type FrameHandle = ResizeHandle | 'rotate';

/** The eight resize handles, in the order artboards already use. */
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * A selection frame: four world-space corners in `nw, ne, se, sw` order.
 * `oriented` records whether it follows one object's own axes.
 */
export interface SelectionFrame {
  corners: [Point, Point, Point, Point];
  rotation: number;
  oriented: boolean;
}

function quadFrame(corners: [Point, Point, Point, Point], oriented: boolean): SelectionFrame {
  const rotation = Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180 / Math.PI;
  return { corners, rotation, oriented };
}

/** The axis-aligned frame of a bounds rectangle. */
export function axisAlignedFrame(bounds: GeometryBounds): SelectionFrame {
  return quadFrame([
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ], false);
}

/** A point inside the frame, addressed in frame coordinates (0-1 covers the box). */
export function framePoint(frame: SelectionFrame, u: number, v: number): Point {
  const [nw, ne, , sw] = frame.corners;
  return {
    x: nw.x + (ne.x - nw.x) * u + (sw.x - nw.x) * v,
    y: nw.y + (ne.y - nw.y) * u + (sw.y - nw.y) * v,
  };
}

export function frameCenter(frame: SelectionFrame): Point {
  return framePoint(frame, 0.5, 0.5);
}

/** Converts a world point into frame coordinates. */
export function projectToFrame(frame: SelectionFrame, point: Point): { u: number; v: number } {
  const [nw, ne, , sw] = frame.corners;
  const ux = ne.x - nw.x;
  const uy = ne.y - nw.y;
  const vx = sw.x - nw.x;
  const vy = sw.y - nw.y;
  const determinant = ux * vy - uy * vx;
  if (Math.abs(determinant) < 1e-9) return { u: 0.5, v: 0.5 };
  const px = point.x - nw.x;
  const py = point.y - nw.y;
  return {
    u: (px * vy - py * vx) / determinant,
    v: (ux * py - uy * px) / determinant,
  };
}

/** Untransformed bounds of an object: the box the handles are attached to. */
export function objectLocalBounds(document: VectorDocument, objectId: EntityId): GeometryBounds {
  return objectBoundsForTransform(document, objectId, IDENTITY_TRANSFORM, INTERACTION_BOUNDS_POLICY);
}

/** An object's own frame: its local bounds carried through its transform. */
export function objectFrame(document: VectorDocument, objectId: EntityId, transform?: ObjectTransform): SelectionFrame | undefined {
  const object = document.getObject(objectId);
  if (!object) return undefined;
  const local = objectLocalBounds(document, objectId);
  const matrix = objectTransformMatrix(transform ?? object.transform);
  return quadFrame([
    transformPoint({ x: local.minX, y: local.minY }, matrix),
    transformPoint({ x: local.maxX, y: local.minY }, matrix),
    transformPoint({ x: local.maxX, y: local.maxY }, matrix),
    transformPoint({ x: local.minX, y: local.maxY }, matrix),
  ], true);
}

/** The frame a selection should advertise: one object's own axes, or a shared box. */
export function selectionFrame(document: VectorDocument, objectIds: Iterable<EntityId>): SelectionFrame | undefined {
  const ids = [...objectIds].filter((objectId) => Boolean(document.getObject(objectId)));
  if (ids.length === 0) return undefined;
  if (ids.length === 1) return objectFrame(document, ids[0]);
  const corners: Point[] = [];
  for (const objectId of ids) {
    const bounds = objectBoundsForTransform(document, objectId, document.getObject(objectId)!.transform, INTERACTION_BOUNDS_POLICY);
    corners.push({ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY });
  }
  const union = boundsForPoints(corners);
  return axisAlignedFrame(union);
}

/**
 * Handle positions in world space, shared by the renderer and hit testing, so a
 * handle is always drawn exactly where it can be grabbed.
 */
export function frameHandlePoints(frame: SelectionFrame): Array<{ handle: ResizeHandle; point: Point }> {
  return [
    { handle: 'nw', point: framePoint(frame, 0, 0) },
    { handle: 'n', point: framePoint(frame, 0.5, 0) },
    { handle: 'ne', point: framePoint(frame, 1, 0) },
    { handle: 'e', point: framePoint(frame, 1, 0.5) },
    { handle: 'se', point: framePoint(frame, 1, 1) },
    { handle: 's', point: framePoint(frame, 0.5, 1) },
    { handle: 'sw', point: framePoint(frame, 0, 1) },
    { handle: 'w', point: framePoint(frame, 0, 0.5) },
  ];
}

export interface FrameHitOptions {
  /** Canvas zoom, so tolerances stay the same size on screen at any magnification. */
  scale?: number;
  handleTolerance?: number;
  rotateZone?: number;
}

/**
 * What the pointer is over: one of the eight resize handles, the rotate zone just
 * outside a corner, or nothing.
 *
 * There is no drawn rotate handle. Like Figma, the control is invisible until the
 * pointer leaves the box diagonally past a corner, where the cursor becomes a
 * rotate arrow. Handle squares win over the band, so grabbing a corner still
 * resizes rather than spinning the selection.
 */
export function frameHitTarget(frame: SelectionFrame, point: Point, options: FrameHitOptions = {}): FrameHandle | undefined {
  const scale = Math.max(options.scale ?? 1, 1e-9);
  const handleTolerance = (options.handleTolerance ?? HANDLE_TOLERANCE) / scale;
  for (const { handle, point: handlePoint } of frameHandlePoints(frame)) {
    if (Math.abs(point.x - handlePoint.x) <= handleTolerance && Math.abs(point.y - handlePoint.y) <= handleTolerance) {
      return handle;
    }
  }
  const { u, v } = projectToFrame(frame, point);
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return undefined;
  const width = Math.hypot(frame.corners[1].x - frame.corners[0].x, frame.corners[1].y - frame.corners[0].y);
  const height = Math.hypot(frame.corners[3].x - frame.corners[0].x, frame.corners[3].y - frame.corners[0].y);
  const zone = (options.rotateZone ?? ROTATE_ZONE) / scale;
  for (const [cornerU, cornerV] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
    const distance = Math.hypot((u - cornerU) * width, (v - cornerV) * height);
    if (distance <= zone) return 'rotate';
  }
  return undefined;
}

/** One object's starting state, captured when a gesture begins. */
export interface TransformTarget {
  objectId: EntityId;
  transform: ObjectTransform;
  localBounds: GeometryBounds;
}

/** The transformable part of a selection: existing, unlocked objects and their start state. */
export function transformTargets(document: VectorDocument, objectIds: Iterable<EntityId>): TransformTarget[] {
  const targets: TransformTarget[] = [];
  for (const objectId of objectIds) {
    const object = document.getObject(objectId);
    if (!object || document.isObjectLocked(objectId)) continue;
    targets.push({
      objectId,
      transform: { ...object.transform },
      localBounds: objectLocalBounds(document, objectId),
    });
  }
  return targets;
}

function targetFrame(target: TransformTarget, transform: ObjectTransform): SelectionFrame {
  const matrix = objectTransformMatrix(transform);
  return quadFrame([
    transformPoint({ x: target.localBounds.minX, y: target.localBounds.minY }, matrix),
    transformPoint({ x: target.localBounds.maxX, y: target.localBounds.minY }, matrix),
    transformPoint({ x: target.localBounds.maxX, y: target.localBounds.maxY }, matrix),
    transformPoint({ x: target.localBounds.minX, y: target.localBounds.maxY }, matrix),
  ], true);
}

export interface TransformPlan {
  handle: FrameHandle;
  objectIds: EntityId[];
  operations: OperationInput[];
}

export interface ResizeOptions {
  /** `Shift`: keep the selection's aspect ratio on corner handles. */
  proportional?: boolean;
}

function resizeFactors(
  handle: ResizeHandle,
  pointerInFrame: { u: number; v: number },
  spanX: number,
  spanY: number,
): { anchorU: number; anchorV: number; scaleX: number; scaleY: number } {
  const movesX = handle.includes('e') || handle.includes('w');
  const movesY = handle.includes('n') || handle.includes('s');
  const anchorU = handle.includes('e') ? 0 : handle.includes('w') ? 1 : 0.5;
  const anchorV = handle.includes('s') ? 0 : handle.includes('n') ? 1 : 0.5;
  const grabU = handle.includes('e') ? 1 : handle.includes('w') ? 0 : 0.5;
  const grabV = handle.includes('s') ? 1 : handle.includes('n') ? 0 : 0.5;
  // The clamp is a fraction of the frame, so a huge selection and a 4 px icon
  // both stop at the same real-world minimum.
  const minX = MIN_SPAN / Math.max(spanX, MIN_SPAN);
  const minY = MIN_SPAN / Math.max(spanY, MIN_SPAN);
  const rawX = movesX ? (pointerInFrame.u - anchorU) / (grabU - anchorU) : 1;
  const rawY = movesY ? (pointerInFrame.v - anchorV) / (grabV - anchorV) : 1;
  return {
    anchorU,
    anchorV,
    scaleX: Number.isFinite(rawX) ? Math.max(rawX, minX) : 1,
    scaleY: Number.isFinite(rawY) ? Math.max(rawY, minY) : 1,
  };
}

/**
 * Builds the resize for one pointer position. `targets` and `frame` must be the
 * values captured at gesture start, so repeated calls never compound.
 */
export function prepareResizeObjects(
  targets: TransformTarget[],
  frame: SelectionFrame,
  handle: ResizeHandle,
  pointer: Point,
  options: ResizeOptions = {},
): TransformPlan | null {
  if (targets.length === 0) return null;
  const spanX = Math.hypot(frame.corners[1].x - frame.corners[0].x, frame.corners[1].y - frame.corners[0].y);
  const spanY = Math.hypot(frame.corners[3].x - frame.corners[0].x, frame.corners[3].y - frame.corners[0].y);
  const { anchorU, anchorV, scaleX: rawX, scaleY: rawY } = resizeFactors(handle, projectToFrame(frame, pointer), spanX, spanY);
  let scaleX = rawX;
  let scaleY = rawY;
  if (options.proportional && (handle.includes('e') || handle.includes('w')) && (handle.includes('n') || handle.includes('s'))) {
    // Follow whichever axis the pointer moved most, so the gesture never fights itself.
    const dominant = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
    scaleX = dominant;
    scaleY = dominant;
  }

  const operations: OperationInput[] = [];
  for (const target of targets) {
    const startFrame = targetFrame(target, target.transform);
    const startAnchor = framePoint(startFrame, anchorU, anchorV);
    const anchorInSelection = projectToFrame(frame, startAnchor);
    // The anchor point a resize holds still, expressed for this object.
    const targetPoint = framePoint(
      frame,
      anchorU + (anchorInSelection.u - anchorU) * scaleX,
      anchorV + (anchorInSelection.v - anchorV) * scaleY,
    );
    const scaled: ObjectTransform = {
      ...target.transform,
      scaleX: target.transform.scaleX * scaleX,
      scaleY: target.transform.scaleY * scaleY,
    };
    const scaledAnchor = framePoint(targetFrame(target, scaled), anchorU, anchorV);
    const next: ObjectTransform = {
      ...scaled,
      x: scaled.x + (targetPoint.x - scaledAnchor.x),
      y: scaled.y + (targetPoint.y - scaledAnchor.y),
    };
    operations.push({ type: 'UPDATE_OBJECT', payload: { objectId: target.objectId, updates: { transform: next } } });
  }

  return { handle, objectIds: targets.map((target) => target.objectId), operations };
}

export interface RotateOptions {
  /** `Shift`: snap to `ROTATION_SNAP` degree steps. */
  snap?: boolean;
}

/**
 * Rotation about the frame centre. Single objects snap their absolute rotation to
 * the grid; multi-selections snap the applied delta, because the objects do not
 * share a rotation to snap.
 */
export function prepareRotateObjects(
  targets: TransformTarget[],
  frame: SelectionFrame,
  startPointer: Point,
  pointer: Point,
  options: RotateOptions = {},
): TransformPlan | null {
  if (targets.length === 0) return null;
  const center = frameCenter(frame);
  const startAngle = Math.atan2(startPointer.y - center.y, startPointer.x - center.x);
  const angle = Math.atan2(pointer.y - center.y, pointer.x - center.x);
  let delta = (angle - startAngle) * 180 / Math.PI;
  delta = ((delta % 360) + 540) % 360 - 180;
  if (options.snap) {
    delta = targets.length === 1
      ? Math.round((targets[0].transform.rotation + delta) / ROTATION_SNAP) * ROTATION_SNAP - targets[0].transform.rotation
      : Math.round(delta / ROTATION_SNAP) * ROTATION_SNAP;
  }
  if (Math.abs(delta) < 1e-9) return null;

  const rotation = rotationMatrix(delta * Math.PI / 180, center);
  const operations: OperationInput[] = [];
  for (const target of targets) {
    const startCenter = frameCenter(targetFrame(target, target.transform));
    const rotated: ObjectTransform = { ...target.transform, rotation: target.transform.rotation + delta };
    const endCenter = frameCenter(targetFrame(target, rotated));
    const wanted = transformPoint(startCenter, rotation);
    const next: ObjectTransform = {
      ...rotated,
      x: rotated.x + (wanted.x - endCenter.x),
      y: rotated.y + (wanted.y - endCenter.y),
    };
    operations.push({ type: 'UPDATE_OBJECT', payload: { objectId: target.objectId, updates: { transform: next } } });
  }
  return { handle: 'rotate', objectIds: targets.map((target) => target.objectId), operations };
}

export function resizeCursor(handle: ResizeHandle): string {
  if (handle === 'n' || handle === 's') return 'ns-resize';
  if (handle === 'e' || handle === 'w') return 'ew-resize';
  return handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize';
}
