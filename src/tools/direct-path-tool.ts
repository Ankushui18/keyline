import type { VectorDocument } from '../core/document';
import type { OperationInput, SplitSegmentPayload } from '../core/operations';
import { multiplyMatrices, objectTransformMatrix, transformPoint, type Matrix2D } from '../core/transforms';
import type { EntityId, Point, SelectionState, VectorNode } from '../core/types';
import { prepareSplitAtPoint } from './cut-tool';

/**
 * Direct path editing, per §3.6 of docs/EDITING-AUDIT.md.
 *
 * Nodes, anchors and handles live in the edited object's **local** space while the
 * pointer arrives in world space. The object transform is the only conversion, and it
 * is applied here rather than in each caller, so the canvas, the tools and the tests
 * all measure the same space.
 */

/** World → local for the object being edited; identity when nothing is being edited. */
export function editingPointMatrix(
  document: VectorDocument,
  editingObjectId: EntityId | undefined,
): Matrix2D | undefined {
  const object = editingObjectId ? document.getObject(editingObjectId) : undefined;
  return object ? objectTransformMatrix(object.transform) : undefined;
}

/** Local → world. The inverse of `objectTransformMatrix` when an object is being edited. */
export function editedObjectPointMatrix(
  document: VectorDocument,
  editingObjectId: EntityId | undefined,
): Matrix2D | undefined {
  const object = editingObjectId ? document.getObject(editingObjectId) : undefined;
  return object ? objectTransformMatrix(object.transform) : undefined;
}

/**
 * The anchors a pointer can target: every node of the edited object's network, not only
 * the selected ones. Hover must be able to name an anchor before it is selected, which is
 * the difference between this and the handle test (handles only exist on selected nodes).
 */
export function pathAnchorOf(
  document: VectorDocument,
  localPoint: Point,
  tolerance: number,
  selection: SelectionState,
): { nodeId: EntityId; position: Point } | undefined {
  if (selection.mode !== 'network' || !selection.editingObjectId) return undefined;
  const object = document.getObject(selection.editingObjectId);
  if (!object || !document.isObjectVisible(object.id) || document.isObjectLocked(object.id)) return undefined;
  const network = document.getNetwork(object.networkId);
  if (!network) return undefined;
  let best: { nodeId: EntityId; position: Point; distance: number } | undefined;
  for (const nodeId of network.nodeIds) {
    const node = document.getNode(nodeId);
    if (!node || !document.isNodeVisible(nodeId)) continue;
    const distance = Math.hypot(node.position.x - localPoint.x, node.position.y - localPoint.y);
    if (distance > tolerance) continue;
    if (!best || distance < best.distance) best = { nodeId, position: { ...node.position }, distance };
  }
  return best ? { nodeId: best.nodeId, position: best.position } : undefined;
}

export interface InsertAnchorPlan {
  split: SplitSegmentPayload;
  /** The anchor the insert will select, once the split is applied. */
  nodeId: EntityId;
  /** `t` along the segment that the pointer projected to. */
  t: number;
}

/**
 * Inserting an anchor is a split at the pointer's projection, which is why it is exact:
 * a cubic split reproduces the same curve, an arc keeps its radius and sweep, and a line
 * stays straight. Kept separate from the Cut tool because the intent and the follow-up
 * selection differ even though the operation is shared.
 */
export function insertAnchorAt(
  document: VectorDocument,
  segmentId: EntityId,
  localPoint: Point,
  selection: SelectionState,
): InsertAnchorPlan | undefined {
  if (selection.mode !== 'network' || !selection.editingObjectId) return undefined;
  const segment = document.getSegment(segmentId);
  if (!segment) return undefined;
  const object = document.getObjectForSegment(segmentId);
  if (!object || object.id !== selection.editingObjectId) return undefined;
  if (!document.isObjectVisible(object.id) || document.isObjectLocked(object.id)) return undefined;
  if (segment.role === 'construction') return undefined;
  // `prepareSplitAtPoint` re-derives the projection itself, so the plan's `t` is the same
  // `t` the split uses. Arcs are allowed: the split preserves radius and sweep.
  const split = prepareSplitAtPoint(document, segmentId, localPoint);
  if (!split) return undefined;
  return { split, nodeId: split.newNodeId, t: split.t };
}

export interface TangentConversionPlan {
  /** Everything the conversion needs, in order: derived handles, then the persistent mode. */
  operations: OperationInput[];
}

/**
 * Corner conversion: the mode is persistent state, and converting to `smooth` or
 * `symmetric` derives the handle pair from the neighbours' positions, so the anchor picks
 * up the local direction of the path instead of keeping whatever handles it happened to
 * have. `corner` leaves the handles alone — it only stops them moving together.
 */
export function convertNodeTangent(
  document: VectorDocument,
  nodeIds: EntityId[],
  mode: 'corner' | 'smooth' | 'symmetric',
): TangentConversionPlan | undefined {
  const unique = [...new Set(nodeIds)];
  if (unique.length === 0) return undefined;
  const nodes = unique.map((nodeId) => document.getNode(nodeId));
  if (nodes.some((node) => !node)) return undefined;
  const operations: OperationInput[] = [];
  // The handles go first: ADD_BEZIER_HANDLES also turns the connected segments into
  // Béziers, and its inverse restores both the handles and the segment types.
  if (mode !== 'corner') {
    for (const node of nodes as VectorNode[]) {
      const pair = derivedTangent(document, node, mode);
      if (pair) {
        operations.push({
          type: 'ADD_BEZIER_HANDLES',
          payload: { nodeId: node.id, handleIn: pair.handleIn, handleOut: pair.handleOut },
        });
      }
    }
  }
  operations.push({
    type: 'SET_NODE_MODES',
    payload: { modes: unique.map((nodeId) => ({ nodeId, mode })) },
  });
  return { operations };
}

/** One tangent pair per node: collinear through the anchor, with the neighbour's length. */
function derivedTangent(
  document: VectorDocument,
  node: VectorNode,
  mode: 'smooth' | 'symmetric',
): { handleIn: Point; handleOut: Point } | undefined {
  const neighbours = document.connectedSegments(node.id)
    .map((segment) => {
      const otherId = segment.startNodeId === node.id ? segment.endNodeId : segment.startNodeId;
      return document.getNode(otherId)?.position;
    })
    .filter((point): point is Point => Boolean(point));
  if (neighbours.length === 0) return undefined;
  const before = neighbours[0];
  const after = neighbours[neighbours.length - 1];
  // A corner of a closed path has two neighbours; an endpoint has one. The tangent runs
  // through the anchor from one neighbour to the other, or away from the only neighbour.
  const direction = neighbours.length >= 2
    ? normalize({ x: after.x - before.x, y: after.y - before.y })
    : normalize({ x: node.position.x - before.x, y: node.position.y - before.y });
  if (!direction) return undefined;
  const outLength = Math.max(1, distance(after, node.position) / 3);
  const inLength = mode === 'symmetric' || neighbours.length < 2
    ? outLength
    : Math.max(1, distance(before, node.position) / 3);
  return {
    handleOut: { x: node.position.x + direction.x * outLength, y: node.position.y + direction.y * outLength },
    handleIn: { x: node.position.x - direction.x * inLength, y: node.position.y - direction.y * inLength },
  };
}

function normalize(vector: Point): Point | undefined {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-8) return undefined;
  return { x: vector.x / length, y: vector.y / length };
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** World-space point for a node of the object being edited, for drawing and hit badges. */
export function nodeWorldPoint(
  document: VectorDocument,
  node: VectorNode,
  objectId: EntityId | undefined,
): Point {
  const object = objectId ? document.getObject(objectId) : undefined;
  return object ? transformPoint(node.position, objectTransformMatrix(object.transform)) : node.position;
}

/** Composes the edited object's matrix with a caller-supplied extra matrix. */
export function composeWithObject(
  document: VectorDocument,
  objectId: EntityId | undefined,
  extra: Matrix2D | undefined,
): Matrix2D | undefined {
  const object = objectId ? document.getObject(objectId) : undefined;
  if (!object) return extra;
  return extra ? multiplyMatrices(objectTransformMatrix(object.transform), extra) : objectTransformMatrix(object.transform);
}
