import type { VectorDocument } from '../core/document';
import type {
  AddBezierHandlesPayload,
  AdjustHandlePayload,
  ConvertToBezierPayload,
} from '../core/operations';
import type { EntityId, HandleMirrorMode, Point, Segment, VectorNode } from '../core/types';

export interface HandleHit {
  nodeId: EntityId;
  handleType: 'in' | 'out';
  point: Point;
}

/** Common path dragging is safe only for production line/Bézier geometry.
 * Native arcs and construction references keep their explicit specialist tools.
 */
export function canDirectBendSegment(segment: Segment | null | undefined): boolean {
  return Boolean(segment && segment.role === 'geometry' && segment.type !== 'arc');
}

export function hitTestHandle(
  document: VectorDocument,
  selectedNodeIds: Set<EntityId>,
  point: Point,
  tolerance: number,
): HandleHit | null {
  for (const nodeId of selectedNodeIds) {
    const node = document.getNode(nodeId);
    if (!node) continue;
    if (node.handleIn && length(subtract(node.handleIn, point)) <= tolerance) {
      return { nodeId, handleType: 'in', point: { ...node.handleIn } };
    }
    if (node.handleOut && length(subtract(node.handleOut, point)) <= tolerance) {
      return { nodeId, handleType: 'out', point: { ...node.handleOut } };
    }
  }
  return null;
}

export function addHandlesFromDrag(node: VectorNode, cursor: Point): AddBezierHandlesPayload {
  const vector = subtract(cursor, node.position);
  return {
    nodeId: node.id,
    handleOut: { ...cursor },
    handleIn: { x: node.position.x - vector.x, y: node.position.y - vector.y },
  };
}

export function defaultHandlesForNode(document: VectorDocument, node: VectorNode): AddBezierHandlesPayload {
  const neighbors = document.connectedSegments(node.id).map((segment) => {
    const otherId = segment.startNodeId === node.id ? segment.endNodeId : segment.startNodeId;
    return document.getNode(otherId)?.position;
  }).filter((point): point is Point => Boolean(point));

  let direction: Point = { x: 1, y: 0 };
  let handleLength = 32;
  if (neighbors.length >= 2) {
    direction = normalize(subtract(neighbors.at(-1)!, neighbors[0]));
    handleLength = neighbors.reduce((sum, point) => sum + length(subtract(point, node.position)), 0) / neighbors.length / 3;
  } else if (neighbors.length === 1) {
    direction = normalize(subtract(neighbors[0], node.position));
    handleLength = length(subtract(neighbors[0], node.position)) / 3;
  }
  if (length(direction) < 1e-8) direction = { x: 1, y: 0 };
  const vector = scale(direction, handleLength);
  return {
    nodeId: node.id,
    handleOut: add(node.position, vector),
    handleIn: subtract(node.position, vector),
  };
}

export function convertSegmentFromDrag(
  document: VectorDocument,
  segmentId: EntityId,
  cursor: Point,
): ConvertToBezierPayload | null {
  const segment = document.getSegment(segmentId);
  if (!segment) return null;
  const start = document.getNode(segment.startNodeId);
  const end = document.getNode(segment.endNodeId);
  if (!start || !end) return null;

  // Convert the dragged midpoint into an equivalent quadratic control point,
  // then degree-elevate it to cubic handles.
  const quadraticControl = {
    x: 2 * cursor.x - 0.5 * (start.position.x + end.position.x),
    y: 2 * cursor.y - 0.5 * (start.position.y + end.position.y),
  };
  return {
    segmentId,
    startHandleOut: {
      x: start.position.x + (2 / 3) * (quadraticControl.x - start.position.x),
      y: start.position.y + (2 / 3) * (quadraticControl.y - start.position.y),
    },
    endHandleIn: {
      x: end.position.x + (2 / 3) * (quadraticControl.x - end.position.x),
      y: end.position.y + (2 / 3) * (quadraticControl.y - end.position.y),
    },
  };
}

export function adjustHandlePayload(
  node: VectorNode,
  handleType: 'in' | 'out',
  newHandle: Point,
  mode: HandleMirrorMode,
): AdjustHandlePayload {
  const opposite = handleType === 'in' ? node.handleOut : node.handleIn;
  let mirroredHandle: Point | undefined;
  if (mode !== 'independent') {
    const vector = subtract(newHandle, node.position);
    const vectorLength = length(vector);
    const oppositeLength = mode === 'mirror'
      ? vectorLength
      : opposite
        ? length(subtract(opposite, node.position))
        : vectorLength;
    const direction = vectorLength > 1e-8 ? scale(vector, -1 / vectorLength) : { x: -1, y: 0 };
    mirroredHandle = add(node.position, scale(direction, oppositeLength));
  }
  return {
    nodeId: node.id,
    handleType,
    newHandle: { ...newHandle },
    mirroredHandle,
  };
}

function add(a: Point, b: Point): Point { return { x: a.x + b.x, y: a.y + b.y }; }
function subtract(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
function scale(point: Point, factor: number): Point { return { x: point.x * factor, y: point.y * factor }; }
function length(point: Point): number { return Math.hypot(point.x, point.y); }
function normalize(point: Point): Point {
  const magnitude = length(point);
  return magnitude > 1e-8 ? scale(point, 1 / magnitude) : { x: 0, y: 0 };
}
